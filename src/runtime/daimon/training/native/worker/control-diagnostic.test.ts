import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createWorkerController, describeNativeFailure } from './control.js';
import { configFixture, executionId, receiptFixture, traceFixture } from '../test-fixtures.js';
import type { NativeAvailability, NativeHost, WorkerOptions } from './types.js';

const ceilingError = 'Codex wake exceeded its 250000-token per-wake ceiling (turn usage 344318 tokens)';

test('failed trace diagnostics omit arbitrary, absent, malformed and unbounded upstream errors', () => {
  for (const error of [undefined, null, 'upstream-private-canary', [], {}, { message: 1 },
    { message: 'upstream-private-canary' }, { message: `${ceilingError}\n` },
    { message: `${ceilingError} upstream-private-canary` },
    { message: ceilingError.replace('250000', '1'.repeat(17)) }]) {
    const trace = { ...traceFixture(), status: 'failed' as const, error };
    assert.equal(describeNativeFailure(receiptFixture(), trace), 'Native execution failed (delivery completed)');
  }
  assert.equal(describeNativeFailure({ ...receiptFixture(), state: 'accepted', deferred: true },
    { ...traceFixture(), status: 'failed' }), 'Native execution failed (delivery accepted deferred)');
});

test('delivery diagnostics do not invent a failed execution from completed or missing telemetry', () => {
  assert.equal(describeNativeFailure(receiptFixture(), traceFixture()), 'Native delivery ended completed');
  for (const state of ['failed', 'stopped', 'accepted'] as const) {
    assert.equal(describeNativeFailure({ ...receiptFixture(), state }, undefined), `Native delivery ended ${state}`);
  }
});

test('a completed inbox delivery retains the real failed execution and reports its token ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-terminal-diagnostic-'));
  try {
    // Sanitized fields from a real native trial: identities are remapped and all
    // prompt, tool, article and model-session content is omitted. Counts, status,
    // receipt disposition, budget and lifecycle error retain the captured values.
    const receipt = { ...receiptFixture(), deferred: false,
      accepted_at: '2026-09-13T20:44:21.707Z', updated_at: '2026-09-13T20:46:38.034Z' };
    const trace = { ...traceFixture(), status: 'failed' as const,
      started_at: '2026-09-13T20:44:21.761Z', completed_at: '2026-09-13T20:46:40.275Z',
      error: { message: ceilingError, stage: 'engine_prompt' } };
    const activity = { version: 'noopolis.daimon.organization-runtime-activity.v2',
      items: [{ ...receipt, active: false }], executions: [] };
    const availability: NativeAvailability = { version: 'noopolis.daimon.work-availability.v1', state: 'paused',
      agents: [{ agent_id: receipt.agent_id, pending: 0, running: false, deferred: 0,
        budget: { armed: true, epoch: 'trial', state: 'paused', reason: 'wake_ceiling', executions_used: 1,
          executions_remaining: 0, tokens_used: 344318, tokens_remaining: 0, agent_executions_used: 1,
          agent_tokens_used: 344318, agent_executions_remaining: 29, agent_tokens_remaining: 7655682 } }] };
    const usage = { v: 'noopolis.daimon.turn-usage.v1', agent: receipt.agent_id, wake: executionId,
      engine: 'codex', at: trace.completed_at, input: 337711, output: 6607, cache_read: 284672,
      total: 344318, complete: true, outcome: 'failed' };
    await mkdir(join(root, 'control'));
    await mkdir(join(root, 'runtime/telemetry'), { recursive: true });
    await mkdir(join(root, 'runtime/.codex/sessions'), { recursive: true });
    await writeFile(join(root, 'runtime/telemetry/turns.ndjson'), `${JSON.stringify(trace)}\n`);
    await writeFile(join(root, 'control/usage.jsonl'), `${JSON.stringify(usage)}\n`);
    // The unit model projection satisfies the independent identity guard, so
    // removing the failed-trace check cannot hide behind missing model evidence.
    await writeFile(join(root, 'runtime/.codex/sessions/unit.jsonl'),
      `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
    const host = { accept: async () => ({ state: 'accepted', acceptance_id: receipt.acceptance_id }),
      wakeReceipt: async () => receipt, activityV2: async () => activity, availability: async () => availability,
      stop: async () => ({ state: 'stopped' }) } as unknown as NativeHost;
    const options: WorkerOptions = { launch: '/launch', config: '/config', configSha256: 'a'.repeat(64),
      controlRoot: join(root, 'control'), tokenFile: '/token', evidence: join(root, 'control/evidence.json'),
      trialId: 'trial', timeoutMs: 1000, scheduleOverride: 'disabled' };
    const result = await createWorkerController(host, configFixture(root), options, 'unit-token').run('wake', 'Assigned work');
    assert.equal(result.status, 'failed');
    assert.equal(result.receipt?.state, 'completed');
    assert.equal(result.receipt.deferred, false);
    assert.deepEqual(result.activity?.executions, []);
    assert.equal(result.native.traces[0]?.status, 'failed');
    assert.equal(result.native.usage[0]?.total, 344318);
    assert.equal(result.error, `Native execution failed: ${ceilingError}`);
    assert.equal(JSON.parse(await readFile(options.evidence, 'utf8')).error, result.error);
  } finally { await rm(root, { recursive: true, force: true }); }
});
