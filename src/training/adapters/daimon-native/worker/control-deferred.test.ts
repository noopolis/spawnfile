import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createWorkerController, describeNativeFailure } from './control.js';
import { configFixture, executionId, receiptFixture, traceFixture } from '../test-fixtures.js';
import type { NativeHost, WorkerOptions } from './types.js';

test('only an accepted deferred delivery with completed telemetry is awaiting external input', () => {
  const receipt = { ...receiptFixture(), state: 'accepted' as const, deferred: true, execution_id: undefined };
  assert.equal(describeNativeFailure(receipt, traceFixture()), 'Native execution completed; delivery blocked awaiting external input');
  for (const trace of [undefined, { ...traceFixture(), status: 'failed' as const }]) {
    assert.doesNotMatch(describeNativeFailure(receipt, trace), /blocked awaiting external input/);
  }
  assert.doesNotMatch(describeNativeFailure({ ...receipt, deferred: false }, traceFixture()), /blocked/);
  assert.doesNotMatch(describeNativeFailure({ ...receipt, state: 'failed' }, traceFixture()), /blocked/);
});

for (const nativeError of [undefined, 'Native engine unavailable']) test(`deferred work retains evidence and native error precedence: ${nativeError ?? 'no error'}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-deferred-unit-'));
  try {
    const receipt = { ...receiptFixture(), state: 'accepted' as const, deferred: true };
    delete receipt.execution_id;
    const trace = traceFixture();
    const usage = { v: 'noopolis.daimon.turn-usage.v1', agent: receipt.agent_id, wake: executionId,
      engine: 'codex', at: trace.completed_at, input: 100, output: 20, cache_read: 40, total: 120, complete: true };
    const tool = { kind: 'moltnet', agent_id: receipt.agent_id, engine: 'codex', delivery_id: 'unit-tool-call',
      at: trace.completed_at, message_id: 'unit-message' };
    for (const directory of ['control', 'runtime/telemetry', 'runtime/tool-state', 'runtime/.codex/sessions']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(join(root, 'runtime/telemetry/turns.ndjson'), `${JSON.stringify(trace)}\n`);
    await writeFile(join(root, 'control/usage.jsonl'), `${JSON.stringify(usage)}\n`);
    await writeFile(join(root, `runtime/tool-state/${'a'.repeat(64)}.json`), JSON.stringify(tool));
    await writeFile(join(root, 'runtime/.codex/sessions/unit.jsonl'),
      `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
    let accepts = 0, stops = 0;
    const host = { accept: async () => { accepts++; return { state: 'accepted', acceptance_id: receipt.acceptance_id }; },
      wakeReceipt: async () => receipt,
      activityV2: async () => ({ version: 'noopolis.daimon.organization-runtime-activity.v2', items: [{ ...receipt, active: false }], executions: [] }),
      availability: async () => ({ state: 'paused', agents: [{ agent_id: receipt.agent_id, pending: 1, deferred: 1,
        ...(nativeError ? { error: nativeError } : {}),
        running: false, budget: { state: 'paused', reason: 'wake_ceiling', executions_remaining: 0 } }] }),
      stop: async () => { stops++; return { state: 'stopped' }; } } as unknown as NativeHost;
    const options: WorkerOptions = { launch: '/launch', config: '/config', configSha256: 'a'.repeat(64),
      controlRoot: join(root, 'control'), tokenFile: '/token', evidence: join(root, 'control/evidence.json'),
      trialId: 'trial', timeoutMs: 1000, scheduleOverride: 'disabled' };
    const controller = createWorkerController(host, configFixture(root), options, 'unit-token');
    const result = await controller.run('wake', 'Unit delivery');
    assert.equal(result.status, 'failed');
    assert.equal(result.blocked, nativeError ? undefined : 'awaiting-external-input');
    assert.equal(result.error, nativeError ?? 'Native execution completed; delivery blocked awaiting external input');
    assert.equal(result.executionId, executionId);
    assert.equal(result.receipt?.state, 'accepted');
    assert.equal(result.native.traces[0]?.status, 'completed');
    assert.deepEqual(result.native.usage, [usage]);
    assert.deepEqual(result.native.toolReceipts, [tool]);
    assert.deepEqual(JSON.parse(await readFile(options.evidence, 'utf8')), result);
    await assert.rejects(controller.run('again', 'No new input'), /exactly one/);
    assert.equal(accepts, 1); assert.equal(stops, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
