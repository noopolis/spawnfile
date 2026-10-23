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
    await writeFile(join(root, 'control/usage.jsonl'), `${JSON.stringify(usage)}\n`);
    await writeFile(join(root, `runtime/tool-state/${'a'.repeat(64)}.json`), JSON.stringify(tool));
    await writeFile(join(root, 'runtime/.codex/sessions/unit.jsonl'),
      `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
    let accepts = 0, stops = 0;
    // The execution exists because the delivery does: its trace is filed after the
    // delivery is accepted, never before it. A trace that predates the delivery is
    // an ordering production cannot produce, and reading one as this wake's own is
    // how another wake's execution gets attributed to this delivery.
    const host = { accept: async () => { accepts++;
        await writeFile(join(root, 'runtime/telemetry/turns.ndjson'), `${JSON.stringify(trace)}\n`);
        return { state: 'accepted', acceptance_id: receipt.acceptance_id }; },
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

/**
 * The third disposition, and the one a live trial met after a single wake.
 *
 * Daimon's dispatcher records an unmarked finished wake as `accepted` **deferred**;
 * `accepted` WITHOUT that marker, with the execution id retained, is written only
 * where a wake came back `stopped` and the runtime reclaimed the delivery for
 * restart. So it is not the agent declining the work and carries no evidence about
 * the subject at all — it is the machine ending the trial, and it must say so
 * rather than reporting an unexplained delivery state.
 *
 * What it must NOT say is which runtime did it. The message used to read "while the
 * runtime kept running" or "by a stopping runtime" off `availability.state`, and
 * that state is the fuse's (running/paused/operator-stopped), read after the fact
 * and on a different clock from the dispatcher's write: it cannot witness the
 * dispatcher's own lifecycle at the moment the record was written. The sentence is
 * the same whatever availability happened to say, and this loop is the guard —
 * the two runtime states must produce byte-identical text.
 */
for (const [runtimeState, code, named] of [['running', 'active_wake_aborted', 'active_wake_aborted'],
  ['running', undefined, 'unrecorded'], ['running', 'invented', 'unrecorded'], ['stopped', 'host_stopping', 'host_stopping']] as const)
  test(`a delivery reclaimed undisposed names its wake outcome and nothing else: ${runtimeState}/${String(code)}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-undisposed-unit-'));
  try {
    const receipt = { ...receiptFixture(), state: 'accepted' as const, ...(code ? { code } : {}) };
    delete receipt.deferred;
    const trace = traceFixture();
    const usage = { v: 'noopolis.daimon.turn-usage.v1', agent: receipt.agent_id, wake: executionId,
      engine: 'codex', at: trace.completed_at, input: 100, output: 20, cache_read: 40, total: 120, complete: true };
    for (const directory of ['control', 'runtime/telemetry', 'runtime/tool-state', 'runtime/.codex/sessions']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(join(root, 'runtime/telemetry/turns.ndjson'), `${JSON.stringify(trace)}\n`);
    await writeFile(join(root, 'control/usage.jsonl'), `${JSON.stringify(usage)}\n`);
    await writeFile(join(root, 'runtime/.codex/sessions/unit.jsonl'),
      `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
    const host = { accept: async () => ({ state: 'accepted', acceptance_id: receipt.acceptance_id }),
      wakeReceipt: async () => receipt,
      activityV2: async () => ({ version: 'noopolis.daimon.organization-runtime-activity.v2', items: [{ ...receipt, active: false }], executions: [] }),
      availability: async () => ({ state: runtimeState, agents: [{ agent_id: receipt.agent_id, pending: 1, deferred: 0, running: false,
        budget: { state: 'available', executions_remaining: 3 } }] }),
      stop: async () => ({ state: 'stopped' }) } as unknown as NativeHost;
    const options: WorkerOptions = { launch: '/launch', config: '/config', configSha256: 'a'.repeat(64),
      controlRoot: join(root, 'control'), tokenFile: '/token', evidence: join(root, 'control/evidence.json'),
      trialId: 'trial', timeoutMs: 2000, scheduleOverride: 'disabled' };
    const result = await createWorkerController(host, configFixture(root), options, 'unit-token')
      .run('wake', 'Unit delivery', { maxExternalDeliveries: 3 });
    // The execution closed and bound; only the delivery's disposition is missing.
    assert.equal(result.executionId, executionId);
    assert.equal(result.native.traces[0]?.status, 'completed');
    // It never becomes a deferral, so no continuation is ever asked for on its behalf.
    assert.equal(result.blocked, undefined);
    assert.equal(result.status, 'failed');
    // The wake outcome is the evidence this process actually holds, and it is the
    // whole of what the message may claim. Availability never enters it.
    assert.equal(result.error, `Native execution completed; delivery reclaimed undisposed (${named})`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
