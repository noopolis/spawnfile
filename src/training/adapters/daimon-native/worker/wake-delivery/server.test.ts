import { expect, test, vi } from 'vitest';
import { createWorkerServer } from '../server.js';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { WorkerController } from '../control.js';
import { receiptFixture } from '../../test-fixtures.js';
import type { NativeAcceptanceResult, NativeWakeRequest } from './types.js';

test('bridge wake HTTP route is authenticated, parses with Daimon and forwards its request and acceptance verbatim', async () => {
  const token = 'isolated-control-token';
  const request = { agent_id: 'agent:writer', delivery_id: 'moltnet:actual-message', event: {
    version: 'noopolis.daimon.wake.v2' as const, kind: 'message' as const, text: '[room tasks] editor\nThe original text', occurred_at: '2026-10-11T12:34:56.789Z' } };
  const accepted = { version: 'noopolis.daimon.wake-acceptance.v2', state: 'accepted' as const, agent_id: request.agent_id,
    delivery_id: request.delivery_id, acceptance_id: receiptFixture().acceptance_id, request_digest: 'f'.repeat(64), accepted_at: '2026-10-11T12:34:57.123Z' };
  let reply: NativeAcceptanceResult = accepted;
  const parse = vi.fn((value: unknown) => value as NativeWakeRequest);
  const accept = vi.fn(async () => reply);
  const read = vi.fn(async () => receiptFixture());
  const run = vi.fn(async () => ({ status: 'failed' }));
  const controller = { host: { wakeReceipt: read }, transport: { accept, state: () => ({ state: 'idle' }) }, run } as unknown as WorkerController;
  expect(() => createWorkerServer(controller, token)).toThrow(/public wake parsing/);
  const server = createWorkerServer(controller, token, parse);
  const url = 'http://unit.invalid';
  const fetch = dispatch(server);
  const post = (path: string, body: unknown, auth: string | undefined = token) => fetch(url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
  try {
    for (const auth of ['', 'wrong-token']) expect((await post('/v2/wakes', request, auth)).status).toBe(401);
    expect(accept).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
    const response = await post('/v2/wakes', request);
    expect(response.status).toBe(202); expect(await response.json()).toEqual(accepted);
    expect(parse).toHaveBeenCalledExactlyOnceWith({ ...request, token });
    expect(accept).toHaveBeenCalledExactlyOnceWith({ ...request, token });
    expect((await fetch(url + '/v2/wakes', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(400);
    const receipt = await fetch(url + '/v2/wake-receipts/' + accepted.acceptance_id, { headers: { authorization: `Bearer ${token}` } });
    expect(receipt.status).toBe(200); expect(await receipt.json()).toEqual(receiptFixture());
    expect(read).toHaveBeenCalledWith(token, accepted.acceptance_id);
    expect(await (await fetch(url + '/trial/run', { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ state: 'idle' });
    const source = { kind: 'transport', deliveryIdPrefix: 'moltnet:' };
    expect((await post('/trial/run', { wakeId: 'task', source })).status).toBe(200);
    expect(run).toHaveBeenCalledWith('task', '', undefined, source);
    for (const body of [{ wakeId: 'task' }, { wakeId: 'task', source, text: 1 }, { wakeId: 'task', source, controls: null }]) {
      expect((await post('/trial/run', body)).status).toBe(400);
    }
    for (const [state, code, status] of [['rejected', 'invalid_request', 400], ['rejected', 'unauthorized', 401],
      ['rejected', 'delivery_conflict', 409], ['stopped', 'host_stopped', 409]] as const) {
      reply = { state, code }; const rejected = await post('/v2/wakes', request);
      expect(rejected.status).toBe(status); expect(await rejected.json()).toEqual(reply);
    }
    parse.mockImplementationOnce(() => { throw new Error('Daimon invalid request'); });
    expect((await post('/v2/wakes', request)).status).toBe(400);
    const before = accept.mock.calls.length;
    expect((await post('/v2/wakes', { ...request, filler: 'x'.repeat(65537) })).status).toBe(400);
    expect(accept.mock.calls.length).toBe(before);
  } finally { server.close(); }
});

test('direct worker closes the transport wake and arming routes', async () => {
  const accept = vi.fn();
  const controller = { host: { accept } } as unknown as WorkerController;
  const server = createWorkerServer(controller, 'token');
  const fetch = dispatch(server);
  try {
    const base = 'http://unit.invalid';
    for (const [path, method] of [['/v2/wakes', 'POST'], ['/trial/run', 'GET']]) {
      expect((await fetch(base + path, { method, headers: { authorization: 'Bearer token' } })).status).toBe(404);
    }
    expect((await fetch(base + '/trial/run', { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ wakeId: 'task', text: 'text', source: { kind: 'transport', deliveryId: 'm:1' } }) })).status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  } finally { server.close(); }
});

/** Exercise real HTTP handlers with byte streams, without binding a TCP port. */
function dispatch(server: Server) {
  return (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; json(): Promise<unknown> }>(resolve => {
      const request = Object.assign(Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]), {
        method: options.method ?? 'GET', url: new URL(url).pathname, headers: options.headers ?? {},
      });
      const response = Object.assign(new EventEmitter(), {
        destroyed: false, writableEnded: false, status: 0,
        writeHead(status: number) { this.status = status; },
        end(value: string) { this.writableEnded = true; resolve({ status: this.status, json: async () => JSON.parse(value) as unknown }); },
      });
      server.emit('request', request, response);
    });
}
