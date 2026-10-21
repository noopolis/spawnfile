import { expect, test } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkerController } from './control.js';
import { activityFixture, configFixture, executionId, launchFixture, receiptFixture, traceFixture } from '../test-fixtures.js';
import { grokConfigFor, grokLaunchFrom } from '../grok-fixtures.js';
import type { NativeHost, WorkerOptions } from './types.js';

const brokerFailure = 'engine broker turn failed (limit_exceeded; limit=timeout; mcp=5/5 answered; mcp_get=1/1 closed, 1 delivered)';
const usage = (limit: string) => ({ v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: executionId, engine: 'grok',
  at: '2026-09-17T00:00:02.000Z', input: 100, output: 10, cache_read: 50, cache_write: 0, total: 160, calls: 1, notional_usd: 0.0001,
  complete: false, turn: 'c'.repeat(64), model: 'grok-4.6', outcome: 'failed', limit_reason: limit });

/** The run52 shape on the direct path: a closed failed execution, the runtime's generic error, and the broker's sealed row. */
async function run(limit: string) {
  const f = await launchFixture();
  const launch = await grokLaunchFrom(f.launch, f.root);
  const config = grokConfigFor(configFixture(f.root));
  const options: WorkerOptions = { launch: f.launch.receiptFile, config: f.launch.config, configSha256: launch.configSha256, controlRoot: launch.controlRoot,
    tokenFile: f.launch.tokenFile, evidence: join(launch.controlRoot, 'evidence.json'), trialId: 'trial', timeoutMs: 2000, scheduleOverride: 'disabled' };
  const host = { accept: async () => ({ state: 'accepted', acceptance_id: receiptFixture().acceptance_id }),
    wakeReceipt: async () => ({ ...receiptFixture(), state: 'failed' }), activityV2: async () => activityFixture(),
    availability: async () => ({ state: 'paused', agents: [{ agent_id: 'agent:writer', error: `engine_failed: ${brokerFailure}` }] }),
    stop: async () => ({ state: 'stopped' }) } as unknown as NativeHost;
  await mkdir(join(f.root, 'runtime/telemetry'), { recursive: true });
  await writeFile(join(f.root, 'runtime/telemetry/turns.ndjson'),
    `${JSON.stringify({ ...traceFixture(), status: 'failed', error: { message: brokerFailure, stage: 'engine_prompt' } })}\n`);
  await mkdir(join(f.root, 'runtime/.codex/sessions'), { recursive: true });
  await writeFile(join(f.root, 'runtime/.codex/sessions/foreign.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } })}\n`);
  await writeFile(launch.broker.usageLedgerPath, `${JSON.stringify(usage(limit))}\n`);
  const result = await createWorkerController(host, config, options, 'unit-token', launch).run('wake', 'Assigned work');
  return { f, result, options };
}

test('a closed execution sealed on its declared limit labels the terminal frame with that limit', async () => {
  const { f, result, options } = await run('timeout');
  try {
    expect(result).toMatchObject({ status: 'failed', limit: 'timeout', executionId,
      error: 'Native execution failed: Grok broker turn limit_exceeded (limit_reason timeout)' });
    expect(JSON.parse(await readFile(options.evidence, 'utf8')).limit).toBe('timeout');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('the broker\'s words without its sealed limit row stay an unlabelled failure', async () => {
  const { f, result } = await run('none');
  try {
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('limit');
    expect(result.error).toBe(`engine_failed: ${brokerFailure}`);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
