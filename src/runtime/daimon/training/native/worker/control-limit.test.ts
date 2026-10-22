import { expect, test } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkerController } from './control.js';
import { activityFixture, configFixture, executionId, launchFixture, receiptFixture, traceFixture } from '../test-fixtures.js';
import { grokConfigFor, grokLaunchFrom } from '../grok-fixtures.js';
import type { NativeActivity, NativeHost, NativeReceipt, WorkerOptions } from './types.js';

const brokerFailure = 'engine broker turn failed (limit_exceeded; limit=timeout; mcp=5/5 answered; mcp_get=1/1 closed, 1 delivered)';
const retryId = '33333333-3333-4333-8333-333333333333';
const usage = (limit: string, wake = executionId) => ({ v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake, engine: 'grok',
  at: '2026-09-17T00:00:02.000Z', input: 100, output: 10, cache_read: 50, cache_write: 0, total: 160, calls: 1, notional_usd: 0.0001,
  complete: false, turn: wake.slice(0, 8).repeat(8), model: 'grok-4.6', outcome: 'failed', limit_reason: limit });
/** A failed trace whose own span is `spanMs`; the worker's configured wake ceiling here is 2000ms. */
const failedTrace = (spanMs: number, turn_id = executionId) => ({ ...traceFixture(), turn_id, status: 'failed',
  started_at: '2026-09-13T00:00:00.000Z', completed_at: new Date(Date.parse('2026-09-13T00:00:00.000Z') + spanMs).toISOString(),
  error: { message: brokerFailure, stage: 'engine_prompt' } });

interface Shape { limit?: string; spanMs?: number; retried?: boolean; running?: boolean }
/**
 * The run52 shape on the direct path: a closed failed execution, the runtime's generic error and
 * the broker's sealed row. `retried` is Daimon's production retry: the failed execution is retried
 * once under a fresh id, and after that also fails the receipt is accepted, deferred and has its
 * execution id cleared, so only the activity projection named the retry while it ran. `running`
 * never closes, so the trial deadline ends the wake.
 */
async function run({ limit = 'timeout', spanMs = 2000, retried = false, running = false }: Shape = {}) {
  const f = await launchFixture();
  const launch = await grokLaunchFrom(f.launch, f.root);
  const config = grokConfigFor(configFixture(f.root));
  const options: WorkerOptions = { launch: f.launch.receiptFile, config: f.launch.config, configSha256: launch.configSha256, controlRoot: launch.controlRoot,
    tokenFile: f.launch.tokenFile, evidence: join(launch.controlRoot, 'evidence.json'), trialId: 'trial', timeoutMs: 2000, scheduleOverride: 'disabled' };
  const receipt = (): NativeReceipt => {
    if (!retried) return { ...receiptFixture(), state: 'failed' };
    const { execution_id: _cleared, ...rest } = receiptFixture();
    return { ...rest, state: 'accepted', deferred: true };
  };
  let polls = 0;
  const activity = (): NativeActivity => running || retried && polls++ === 0 ? { ...activityFixture(), executions: [{ agent_id: 'agent:writer',
    execution_id: retried ? retryId : executionId, delivery_ids: ['trial:wake'], state: 'running' }] } : activityFixture();
  const host = { accept: async () => ({ state: 'accepted', acceptance_id: receiptFixture().acceptance_id }),
    wakeReceipt: async () => receipt(), activityV2: async () => activity(),
    availability: async () => ({ state: 'paused', agents: [{ agent_id: 'agent:writer', error: `engine_failed: ${brokerFailure}` }] }),
    stop: async () => ({ state: 'stopped' }) } as unknown as NativeHost;
  await mkdir(join(f.root, 'runtime/telemetry'), { recursive: true });
  const traces = retried ? [failedTrace(spanMs), failedTrace(spanMs, retryId)] : running ? [] : [failedTrace(spanMs)];
  await writeFile(join(f.root, 'runtime/telemetry/turns.ndjson'), traces.map(row => `${JSON.stringify(row)}\n`).join(''));
  await mkdir(join(f.root, 'runtime/.codex/sessions'), { recursive: true });
  await writeFile(join(f.root, 'runtime/.codex/sessions/foreign.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } })}\n`);
  const rows = retried ? [usage(limit), usage(limit, retryId)] : [usage(limit)];
  await writeFile(launch.broker.usageLedgerPath, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
  const result = await createWorkerController(host, config, options, 'unit-token', launch).run('wake', 'Assigned work');
  return { f, result, options };
}

test('a closed execution sealed on its declared limit labels the terminal frame with that limit', async () => {
  const { f, result, options } = await run();
  try {
    expect(result).toMatchObject({ status: 'failed', limit: 'timeout', executionId,
      error: 'Native execution failed: Grok broker turn limit_exceeded (limit_reason timeout)' });
    expect(JSON.parse(await readFile(options.evidence, 'utf8')).limit).toBe('timeout');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test.each([
  ['the broker\'s words without its sealed limit row', { limit: 'none' }],
  // Daimon seals its idle watchdog as the same `timeout`: a turn that stopped well short
  // of the wake ceiling this worker configured is a hang, not the subject's budget.
  ['an idle-watchdog timeout short of the configured wake ceiling', { spanMs: 1000 }],
] as const)('%s stays an unlabelled failure', async (_name, shape) => {
  const { f, result } = await run(shape);
  try {
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('limit');
    expect(result.error).toBe(`engine_failed: ${brokerFailure}`);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Daimon\'s retry shape still binds the retried execution and labels its declared limit', async () => {
  const { f, result } = await run({ retried: true });
  try {
    expect(result.receipt).toMatchObject({ state: 'accepted', deferred: true });
    expect(result.receipt).not.toHaveProperty('execution_id');
    expect(result).toMatchObject({ status: 'failed', limit: 'timeout', executionId: retryId });
    expect(result).not.toHaveProperty('blocked');
    expect(result.native.traces.map(trace => trace.turn_id)).toEqual([retryId]);
    // The first attempt's spend is still accounted for the trial.
    expect(result.native.accounting?.usage.map(row => row.wake).sort()).toEqual([executionId, retryId].sort());
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a wake the trial deadline ends is never labelled, even with a sealed limit row in the ledger', async () => {
  const { f, result } = await run({ running: true });
  try {
    expect(result).toMatchObject({ status: 'failed', error: 'Native trial deadline exceeded' });
    expect(result).not.toHaveProperty('limit');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
