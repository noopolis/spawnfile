import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createWorkerServer, listenWorker } from './server.js';
import { activityFixture } from '../test-fixtures.js';
import type { WorkerController } from './control.js';

test('activity route requires bearer authentication and forwards the native value unchanged', async () => {
  let calls = 0;
  const native = activityFixture(true);
  const controller = { host: { activityV2: async (token: string) => {
    assert.equal(token, 'unit-test-secret'); calls++; return native;
  } } } as unknown as WorkerController;
  const server = createWorkerServer(controller, 'unit-test-secret');
  await listenWorker(server, '127.0.0.1', 0);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/v2/activity`)).status, 401);
    assert.equal(calls, 0);
    const response = await fetch(`${origin}/v2/activity`, { headers: { authorization: 'Bearer unit-test-secret' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), native);
    assert.equal(calls, 1);
    assert.equal((await fetch(`${origin}/v2/activity?fake=running`, { headers: { authorization: 'Bearer unit-test-secret' } })).status, 400);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
