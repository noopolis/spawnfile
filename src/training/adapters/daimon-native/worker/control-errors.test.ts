import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerController, executionClosed } from './control.js';
import { configFixture, activityFixture, receiptFixture, traceFixture } from '../test-fixtures.js';
import type { NativeHost, WorkerOptions } from './types.js';
import { launchFixture } from '../test-fixtures.js';

test('terminal closure rejects unknown authority and unrelated or multiple native executions', () => {
  assert.throws(() => executionClosed({ ...activityFixture(), executions: [{ ...activityFixture(true).executions![0]!, agent_id: 'other' }] }, receiptFixture(), [], 'agent:writer'), /Unexpected/);
  assert.throws(() => executionClosed(activityFixture(), receiptFixture(), [traceFixture(), traceFixture()], 'agent:writer'), /multiple/);
});

test('native stop deadline remains unknown and terminal evidence retains the preparation receipt', async () => {
  const f = await launchFixture();
  try {
    const options: WorkerOptions = { launch: f.launch.receiptFile, config: f.launch.config, configSha256: f.launch.configSha256,
      controlRoot: f.launch.controlRoot, tokenFile: f.launch.tokenFile, evidence: join(f.launch.controlRoot, 'evidence.json'),
      trialId: 'unit', timeoutMs: 1000, scheduleOverride: 'disabled' };
    const host = { accept: async () => ({ state: 'rejected', code: 'invalid_request' }), stop: async () => ({}) } as unknown as NativeHost;
    const result = await createWorkerController(host, configFixture(f.root), options, 'unit-token', f.launch).run('wake', 'Unit delivery');
    assert.deepEqual(result.preparation?.overrides, f.launch.overrides);
    host.stop = () => new Promise(() => undefined);
    vi.useFakeTimers();
    const pending = createWorkerController(host, configFixture(f.root), options, 'unit-token').stop();
    await vi.advanceTimersByTimeAsync(5001);
    assert.equal((await pending).state, 'unknown');
  } finally { vi.useRealTimers(); await rm(f.root, { recursive: true, force: true }); }
});

test('control records native failures, cancellation and absent evidence without completion claims', async () => {
  for (const variant of ['missing', 'foreign', 'authority', 'native-error', 'deferred', 'missing-usage', 'missing-model', 'cancelled', 'stop-fails']) {
    const root = await mkdtemp(join(tmpdir(), 'native-errors-unit-'));
    try {
      await mkdir(join(root, 'control')); await mkdir(join(root, 'runtime/telemetry'), { recursive: true });
      if (['deferred', 'missing-usage', 'missing-model'].includes(variant)) await writeFile(join(root, 'runtime/telemetry/turns.ndjson'), `${JSON.stringify(traceFixture())}\n`);
      if (variant === 'missing-model') await writeFile(join(root, 'control/usage.jsonl'), `${JSON.stringify({ v: 'noopolis.daimon.turn-usage.v1',
        agent: 'agent:writer', wake: traceFixture().turn_id, engine: 'codex', at: new Date().toISOString(), input: 1, output: 1, cache_read: 0, total: 2, complete: true })}\n`);
      const host = {
        accept: async () => ({ state: 'accepted', acceptance_id: receiptFixture().acceptance_id }),
        wakeReceipt: async () => variant === 'missing' ? undefined : { ...receiptFixture(), agent_id: variant === 'foreign' ? 'other' : 'agent:writer',
          state: variant === 'deferred' ? 'accepted' : 'completed', deferred: variant === 'deferred' },
        activityV2: async () => variant === 'authority' ? { ...activityFixture(), executions: undefined } : activityFixture(),
        availability: async () => ({ state: 'running', agents: [{ agent_id: 'agent:writer',
          ...(['native-error', 'stop-fails'].includes(variant) ? { error: 'Native engine failed' } : {}) }] }),
        stop: async () => { if (variant === 'stop-fails') throw new Error('Native stop failed'); return { state: 'stopped' }; },
      } as unknown as NativeHost;
      const options: WorkerOptions = { launch: '/launch', config: '/config', configSha256: 'a'.repeat(64), controlRoot: join(root, 'control'), tokenFile: '/token',
        evidence: join(root, 'control/evidence.json'), trialId: 'trial', timeoutMs: 300, scheduleOverride: 'disabled' };
      const controller = createWorkerController(host, configFixture(root), options, 'unit-token');
      await assert.rejects(controller.run('invalid id', ''), /Invalid bounded/);
      const pending = controller.run('wake', 'Assigned work');
      if (variant === 'cancelled') setTimeout(() => { void controller.stop(); }, 10);
      const result = await pending;
      assert.equal(result.status, variant === 'cancelled' ? 'cancelled' : 'failed', variant);
      if (variant === 'stop-fails') assert.equal((await controller.stop()).state, 'unknown');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
