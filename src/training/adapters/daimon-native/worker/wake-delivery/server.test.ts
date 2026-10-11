import { expect, test, vi } from 'vitest';
import { createWorkerServer, listenWorker } from '../server.js';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createSourceFile, isFunctionDeclaration, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { WorkerController } from '../control.js';
import type { NativeHost } from '../types.js';
import { activityFixture, configFixture, receiptFixture, traceFixture } from '../../test-fixtures.js';
import { createTransportDelivery } from './transport.js';
import type { NativeAcceptance, NativeAcceptanceResult, NativeWakeRequest } from './types.js';

// Resolve the optional installed package only through its public runtime export.
// Acceptance persistence below is a double; parsing/digest and rejection are real.
const packageName = '@noopolis/daimon/runtime';
const daimon = await import(packageName) as {
  parseWakeAcceptanceRequest(value: unknown): NativeWakeRequest;
  wakeAcceptanceDigest(value: NativeWakeRequest): string;
  createOrganizationRuntimeControlHost(config: unknown, options: { acceptanceStorePath: string; controlToken: string }): NativeHost;
};
const token = 'isolated-control-token';
const request: Omit<NativeWakeRequest, 'token'> = {
  agent_id: 'agent:writer', delivery_id: 'moltnet:actual-message', event: {
    version: 'noopolis.daimon.wake.v2', kind: 'message', text: '[room tasks] éditor\nThe original text', occurred_at: '2026-10-11T12:34:56.789Z',
  },
};

test('bridge wake HTTP preserves native parsed identity and digest across authenticated retries', async () => {
  const stored = new Map<string, NativeAcceptance>();
  const accept = vi.fn(async (value: unknown): Promise<NativeAcceptanceResult> => {
    const parsed = daimon.parseWakeAcceptanceRequest(value);
    const digest = daimon.wakeAcceptanceDigest(parsed);
    const key = JSON.stringify([parsed.agent_id, parsed.delivery_id]);
    const previous = stored.get(key);
    if (previous) return previous.request_digest === digest ? previous : {
      version: 'noopolis.daimon.wake-acceptance.v2', state: 'rejected', code: 'delivery_conflict',
    };
    const accepted: NativeAcceptance = {
      version: 'noopolis.daimon.wake-acceptance.v2', state: 'accepted', agent_id: parsed.agent_id,
      delivery_id: parsed.delivery_id, acceptance_id: receiptFixture().acceptance_id,
      request_digest: digest, accepted_at: '2026-10-11T12:34:57.123Z',
    };
    stored.set(key, accepted);
    return accepted;
  });
  const host = { accept } as unknown as NativeHost;
  const transport = createTransportDelivery(host, request.agent_id);
  const run = transport.begin('task', { kind: 'transport', deliveryIdPrefix: 'moltnet:' });
  const server = createWorkerServer({ host, transport } as unknown as WorkerController, token);
  const call = requests(server);
  try {
    for (const authorization of ['', 'wrong-token']) expect((await call.post('/v2/wakes', request, authorization)).status).toBe(401);
    expect(accept).not.toHaveBeenCalled();
    const response = await call.post('/v2/wakes', { ...request, token: 'body-cannot-override-header' });
    const accepted = await response.json() as NativeAcceptance;
    expect(response.status).toBe(202);
    expect(accepted).toEqual(stored.get(JSON.stringify([request.agent_id, request.delivery_id])));
    expect(accepted.request_digest).toBe(daimon.wakeAcceptanceDigest(daimon.parseWakeAcceptanceRequest({ ...request, token })));
    expect(accept).toHaveBeenCalledExactlyOnceWith({ ...request, token });
    const reordered = { event: { occurred_at: request.event.occurred_at, text: request.event.text,
      kind: request.event.kind, version: request.event.version }, delivery_id: request.delivery_id, agent_id: request.agent_id };
    const retry = await call.post('/v2/wakes', reordered);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(accepted);
    const changed = { ...request, event: { ...request.event, text: 'Different message' } };
    expect(daimon.wakeAcceptanceDigest(daimon.parseWakeAcceptanceRequest({ ...changed, token }))).not.toBe(accepted.request_digest);
    const conflict = await call.post('/v2/wakes', changed);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ version: 'noopolis.daimon.wake-acceptance.v2', state: 'rejected', code: 'delivery_conflict' });
    expect(accept.mock.calls).toEqual([[{ ...request, token }], [{ ...reordered, token }], [{ ...changed, token }]]);
    run.observe({ ...receiptFixture(), ...accepted, state: 'completed' }, activityFixture(), {
      version: 'availability', state: 'running', agents: [{ agent_id: request.agent_id, pending: 0, running: false, deferred: 0, budget: {} }],
    });
    expect(run.seal(run.generation(), [traceFixture()])).toBe(true);
    const sealed = await call.post('/v2/wakes', { ...request, delivery_id: 'moltnet:late' });
    expect(sealed.status).toBe(409);
    expect(await sealed.json()).toEqual({ error: 'transport_admission_sealed' });
    expect(accept).toHaveBeenCalledTimes(3);
    expect(await (await call.post('/v2/wakes', request)).json()).toEqual(accepted);
    expect(await (await call.post('/v2/wakes', changed)).json()).toEqual({
      version: 'noopolis.daimon.wake-acceptance.v2', state: 'rejected', code: 'delivery_conflict',
    });
  } finally { server.close(); }
});

test('native host owns schema rejection and all structured rejection fields reach the bridge', async () => {
  // An unstarted public host validates without launching an engine or writing state.
  const host = daimon.createOrganizationRuntimeControlHost(configFixture(), {
    acceptanceStorePath: '/unused-unstarted-native-host', controlToken: token,
  });
  const accept = vi.spyOn(host, 'accept');
  const transport = createTransportDelivery(host, request.agent_id);
  const server = createWorkerServer({ host, transport } as unknown as WorkerController, token);
  const call = requests(server);
  try {
    const beforeArm = await call.post('/v2/wakes', request);
    expect(beforeArm.status).toBe(409);
    expect(await beforeArm.json()).toEqual({ error: 'transport_admission_sealed' });
    expect(accept).not.toHaveBeenCalled();
    transport.begin('task', { kind: 'transport', deliveryId: request.delivery_id });
    for (const invalid of [{}, { ...request, extra: 'not allowed' },
      { ...request, event: { ...request.event, kind: 'invented' } },
      { ...request, event: { ...request.event, occurred_at: '2026-10-11T12:34:56Z' } },
      { ...request, event: { ...request.event, text: 'é'.repeat(8193) } }]) {
      const expected = await host.accept({ ...invalid, token });
      accept.mockClear();
      const response = await call.post('/v2/wakes', invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expected);
      expect(expected).toEqual({ version: 'noopolis.daimon.wake-acceptance.v2', state: 'rejected', code: 'invalid_request' });
      expect(accept).toHaveBeenCalledExactlyOnceWith({ ...invalid, token });
    }
    const blocked = await call.post('/v2/wakes', request);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual(await host.accept({ ...request, token }));
    const foreign = { ...request, agent_id: 'agent:unknown' };
    expect(await (await call.post('/v2/wakes', foreign)).json()).toEqual(await host.accept({ ...foreign, token }));
    const unauthorized = { version: 'noopolis.daimon.wake-acceptance.v2', state: 'rejected', code: 'unauthorized' } as const;
    accept.mockResolvedValueOnce(unauthorized);
    const response = await call.post('/v2/wakes', request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
    accept.mockClear();
    for (const value of [null, [], 'text', 0, false]) {
      const malformed = await call.post('/v2/wakes', value);
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: 'request body must be an object' });
    }
    expect(accept).not.toHaveBeenCalled();
    const contentType = await call.fetch('http://unit.invalid/v2/wakes', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    expect(contentType.status).toBe(400);
    expect(await contentType.json()).toEqual({ error: 'content-type must be application/json' });
  } finally { accept.mockRestore(); server.close(); }
});

test('bridge wake HTTP accepts exactly 1,048,576 bytes and rejects the next byte before native admission', async () => {
  const accept = vi.fn(async (value: unknown): Promise<NativeAcceptanceResult> => {
    const parsed = daimon.parseWakeAcceptanceRequest(value);
    return { state: 'accepted', acceptance_id: receiptFixture().acceptance_id, agent_id: parsed.agent_id,
      delivery_id: parsed.delivery_id, request_digest: daimon.wakeAcceptanceDigest(parsed) };
  });
  const host = { accept } as unknown as NativeHost;
  const transport = createTransportDelivery(host, request.agent_id);
  transport.begin('task', { kind: 'transport', deliveryId: request.delivery_id });
  const server = createWorkerServer({ host, transport } as unknown as WorkerController, token);
  const call = requests(server);
  const json = JSON.stringify(request);
  const bytes = Buffer.byteLength(json);
  try {
    for (const size of [65_537, 1_048_576]) {
      const response = await call.raw(json + ' '.repeat(size - bytes));
      expect(response.status).toBe(202);
      expect((await response.json() as NativeAcceptance).request_digest).toBe(daimon.wakeAcceptanceDigest(daimon.parseWakeAcceptanceRequest({ ...request, token })));
    }
    expect(accept).toHaveBeenCalledTimes(2);
    const tooLarge = await call.raw(json + ' '.repeat(1_048_577 - bytes));
    expect(tooLarge.status).toBe(400);
    expect(await tooLarge.json()).toEqual({ error: 'request body is too large' });
    expect(accept).toHaveBeenCalledTimes(2);
  } finally { server.close(); }
});

test('wake status, body and Retry-After match the installed Daimon HTTP route for every acceptance outcome', async () => {
  // Execute the installed route and its helpers verbatim, without running the CLI,
  // constructing a native runtime, starting an engine or binding a TCP listener.
  const source = await readFile('node_modules/@noopolis/daimon/src/runtime/cli.ts', 'utf8');
  const parsed = createSourceFile('cli.ts', source, ScriptTarget.ES2022, true);
  const names = ['handleRequest', 'authorized', 'readJson', 'bodyRecord', 'respond'];
  const declarations = parsed.statements.filter(node => isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''));
  expect(declarations).toHaveLength(names.length);
  const bound = parsed.statements.find(node => node.getText(parsed).startsWith('const MAX_BODY_BYTES ='));
  expect(bound).toBeDefined();
  const code = transpileModule([bound!, ...declarations].map(node => node.getText(parsed)).join('\n'), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext },
  }).outputText;
  const handle = runInNewContext(`${code}\nhandleRequest`, { Buffer, URL, createHash, timingSafeEqual }) as
    (request: unknown, response: unknown, host: NativeHost, control: NativeHost, token: string) => Promise<void>;
  const outcomes: NativeAcceptanceResult[] = [
    { ...receiptFixture(), state: 'accepted' },
    ...['invalid_request', 'unauthorized', 'unknown_agent', 'delivery_conflict'].map(code => ({ state: 'rejected' as const, code })),
    ...['operator_stop', 'ledger_unavailable', 'host_stopping', 'host_stopped', 'queue_full'].map(reason => ({
      version: 'noopolis.daimon.wake-acceptance.v2', state: 'stopped' as const,
      code: reason === 'host_stopped' ? 'host_stopped' : 'host_stopping',
      blocked: { version: 'noopolis.daimon.work-blocked.v1', reason, retry_after_ms: 30000 },
    })),
  ];
  const accept = vi.fn<NativeHost['accept']>();
  const host = { accept } as unknown as NativeHost;
  const transport = createTransportDelivery(host, request.agent_id);
  transport.begin('task', { kind: 'transport', deliveryId: request.delivery_id });
  const worker = createWorkerServer({ host, transport } as unknown as WorkerController, token);
  const native = new EventEmitter() as Server;
  native.on('request', (incoming, response) => { void handle(incoming, response, host, host, token); });
  try {
    for (const outcome of outcomes) {
      accept.mockResolvedValue(outcome);
      const expected = await requests(native).post('/v2/wakes', request);
      const actual = await requests(worker).post('/v2/wakes', request);
      expect(actual.status).toBe(expected.status);
      expect(actual.headers).toEqual(expected.headers);
      expect(actual.headers['retry-after']).toBeUndefined();
      expect(await actual.json()).toEqual(await expected.json());
      expect(await actual.json()).toEqual(outcome);
    }
  } finally { worker.close(); }
});

test('transport receipt reads and arming preserve their native and caller identities', async () => {
  const read = vi.fn(async () => receiptFixture());
  const run = vi.fn(async () => ({ status: 'failed' }));
  const controller = { host: { wakeReceipt: read }, transport: { state: () => ({ state: 'idle' }) }, run } as unknown as WorkerController;
  const server = createWorkerServer(controller, token);
  const call = requests(server);
  try {
    const receipt = await call.fetch('http://unit.invalid/v2/wake-receipts/' + receiptFixture().acceptance_id, { headers: { authorization: 'Bearer ' + token } });
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toEqual(receiptFixture());
    expect(read).toHaveBeenCalledExactlyOnceWith(token, receiptFixture().acceptance_id);
    expect(await (await call.fetch('http://unit.invalid/trial/run', { headers: { authorization: 'Bearer ' + token } })).json()).toEqual({ state: 'idle' });
    const source = { kind: 'transport', deliveryIdPrefix: 'moltnet:' };
    expect((await call.post('/trial/run', { wakeId: 'task', source })).status).toBe(200);
    expect(run).toHaveBeenCalledExactlyOnceWith('task', '', undefined, source);
    for (const body of [{ wakeId: 'task' }, { wakeId: 'task', source, text: 1 }, { wakeId: 'task', source, controls: null }]) {
      expect((await call.post('/trial/run', body)).status).toBe(400);
    }
  } finally { server.close(); }
});

test('direct worker closes the transport wake and arming routes', async () => {
  const accept = vi.fn();
  const controller = { host: { accept } } as unknown as WorkerController;
  const server = createWorkerServer(controller, token);
  const call = requests(server);
  try {
    for (const [path, method] of [['/v2/wakes', 'POST'], ['/trial/run', 'GET']]) {
      expect((await call.fetch('http://unit.invalid' + path, { method, headers: { authorization: 'Bearer ' + token } })).status).toBe(404);
    }
    expect((await call.post('/trial/run', { wakeId: 'task', text: 'text', source: { kind: 'transport', deliveryId: 'm:1' } })).status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  } finally { server.close(); }
});

test('direct HTTP controls retain their native values, unavailable states and smaller request bound', async () => {
  let available = true;
  const health = vi.fn(async () => ({ state: 'running' }));
  const read = vi.fn(async () => available ? receiptFixture() : undefined);
  const run = vi.fn(async () => ({ status: 'failed' }));
  const stop = vi.fn(async () => ({ state: 'acknowledged' }));
  const controller = { host: { health, wakeReceipt: read, activityV2: read, availability: read }, run, stop } as unknown as WorkerController;
  const server = createWorkerServer(controller, token);
  const call = requests(server);
  const get = (path: string) => call.fetch('http://unit.invalid' + path, { headers: { authorization: 'Bearer ' + token } });
  try {
    expect(await (await get('/trial/health')).json()).toEqual({ state: 'running' });
    for (const path of ['/v2/activity', '/v2/availability']) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(receiptFixture());
    }
    expect((await get('/v2/activity?foreign=identity')).status).toBe(400);
    expect((await call.post('/trial/stop', {})).status).toBe(200);
    expect(stop).toHaveBeenCalledExactlyOnceWith();
    expect((await call.post('/trial/run', { wakeId: 'direct', text: 'unchanged' })).status).toBe(200);
    expect(run).toHaveBeenCalledExactlyOnceWith('direct', 'unchanged', undefined, undefined);
    expect((await call.post('/trial/run', { wakeId: 'direct', text: 'unchanged', controls: { maxExternalDeliveries: 1 } })).status).toBe(200);
    for (const value of [null, { wakeId: 'direct', text: 'x'.repeat(32_769) }, { wakeId: 'direct', text: 'unchanged', controls: [] }]) {
      expect((await call.post('/trial/run', value)).status).toBe(400);
    }
    expect((await call.fetch('http://unit.invalid/trial/run', { method: 'POST', headers: { authorization: 'Bearer ' + token } })).status).toBe(400);
    available = false;
    for (const path of ['/v2/activity', '/v2/availability']) expect((await get(path)).status).toBe(503);
    expect((await get('/v2/wake-receipts/' + receiptFixture().acceptance_id)).status).toBe(404);
    health.mockRejectedValueOnce('not-an-error');
    expect(await (await get('/trial/health')).json()).toEqual({ error: 'worker_request_failed' });
  } finally { server.close(); }
});

test('an abandoned run stops the owned controller and listener failures reject startup', async () => {
  const stop = vi.fn(async () => ({ state: 'acknowledged' }));
  let response: EventEmitter;
  const run = vi.fn(async () => { response.emit('close'); return { status: 'failed' }; });
  const server = createWorkerServer({ host: {}, run, stop } as unknown as WorkerController, token);
  server.prependListener('request', (_request, value) => { response = value; });
  try {
    expect((await requests(server).post('/trial/run', { wakeId: 'direct', text: 'unchanged' })).status).toBe(200);
    expect(stop).toHaveBeenCalledExactlyOnceWith();
    response!.emit('close');
    expect(stop).toHaveBeenCalledTimes(1);
  } finally { server.close(); }
  const listener = Object.assign(new EventEmitter(), { listen: vi.fn((_port: number, _host: string, ready: () => void) => { ready(); }) });
  await listenWorker(listener as unknown as Server, '127.0.0.1', 0);
  expect(listener.listenerCount('error')).toBe(0);
  listener.listen.mockImplementationOnce(() => { listener.emit('error', new Error('refused')); });
  await expect(listenWorker(listener as unknown as Server, '127.0.0.1', 0)).rejects.toThrow('refused');
});

function requests(server: Server) {
  const fetch = dispatch(server);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token };
  return {
    fetch,
    raw: (body: string) => fetch('http://unit.invalid/v2/wakes', { method: 'POST', headers, body }),
    post: (path: string, body: unknown, authorization = token) => fetch('http://unit.invalid' + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization: 'Bearer ' + authorization } : {}) }, body: JSON.stringify(body),
    }),
  };
}

/** Exercise real HTTP handlers with byte streams, without binding a TCP port. */
function dispatch(server: Server) {
  return (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: Record<string, string>; json(): Promise<unknown> }>(resolve => {
      const request = Object.assign(Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]), {
        method: options.method ?? 'GET', url: new URL(url).pathname + new URL(url).search, headers: options.headers ?? {},
      });
      const response = Object.assign(new EventEmitter(), {
        destroyed: false, writableEnded: false, status: 0, headers: {} as Record<string, string>,
        writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; },
        end(value: string) { this.writableEnded = true; resolve({ status: this.status, headers: this.headers, json: async () => JSON.parse(value) as unknown }); },
      });
      server.emit('request', request, response);
    });
}
