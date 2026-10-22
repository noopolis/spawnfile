import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createWorkerServer, listenWorker } from './server.js';
import { activityFixture, receiptFixture } from '../test-fixtures.js';
import type { WorkerController } from './control.js';

test('HTTP surface forwards health, receipt, availability, native run and stop results', async () => {
  let available = true;
  let body: unknown;
  const controller = { host: { health: async () => ({ state: 'running' }), activityV2: async () => available ? activityFixture() : undefined,
    availability: async () => available ? { state: 'running' } : undefined, wakeReceipt: async () => available ? receiptFixture() : undefined },
    run: async (wakeId: string, text: string) => { body = { wakeId, text }; return { status: 'failed' }; },
    stop: async () => ({ state: 'acknowledged' }) } as unknown as WorkerController;
  const server = createWorkerServer(controller, 'test-secret'); await listenWorker(server, '127.0.0.1', 0);
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, options: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    ...options, headers: { authorization: 'Bearer test-secret', ...options.headers } });
  try {
    for (const path of ['/trial/health', '/v2/availability', `/v2/wake-receipts/${receiptFixture().acceptance_id}`]) assert.equal((await call(path)).status, 200);
    assert.equal((await call('/trial/stop', { method: 'POST' })).status, 200);
    assert.equal((await call('/unknown')).status, 404);
    assert.equal((await call('/trial/run', { method: 'POST' })).status, 400);
    const post = (value: string) => call('/trial/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: value });
    for (const value of ['{}', 'null', '[]', '{', JSON.stringify({ wakeId: 'wake', text: 'text', injected: true }),
      ...[null, [], 1].map(controls => JSON.stringify({ wakeId: 'wake', text: 'text', controls }))]) assert.equal((await post(value)).status, 400);
    assert.equal((await post(JSON.stringify({ wakeId: 'wake', text: 'text' }))).status, 200);
    assert.deepEqual(body, { wakeId: 'wake', text: 'text' });
    assert.equal((await post(JSON.stringify({ wakeId: 'wake', text: 'text', controls: { maxExternalDeliveries: 1 } }))).status, 200);
    available = false;
    assert.equal((await call('/v2/activity')).status, 503);
    assert.equal((await call('/v2/availability')).status, 503);
    assert.equal((await call(`/v2/wake-receipts/${receiptFixture().acceptance_id}`)).status, 404);
    assert.equal((await post(JSON.stringify({ wakeId: 'wake', text: 'x'.repeat(40000) }))).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
