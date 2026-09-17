import { expect, test } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkerController, describeNativeFailure } from './control.js';
import { activityFixture, configFixture, executionId, launchFixture, receiptFixture, traceFixture } from '../test-fixtures.js';
import { grokConfigFor, grokLaunchFrom } from '../grok-fixtures.js';
import type { NativeGrokUsage, NativeHost, NativeTrace, WorkerOptions } from './types.js';

const turn = 'c'.repeat(64);
const usage = { v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: executionId, engine: 'grok', at: '2026-09-17T00:00:02.000Z',
  input: 100, output: 10, cache_read: 50, cache_write: 0, total: 160, calls: 1, notional_usd: 0.0001, complete: true, turn, model: 'grok-4.6', limit_reason: 'none' };

test('Grok controller reads the broker slot ledger, records engine identity and never reads Codex sessions', async () => {
  const f = await launchFixture();
  try {
    const launch = await grokLaunchFrom(f.launch, f.root);
    const config = grokConfigFor(configFixture(f.root));
    const options: WorkerOptions = { launch: f.launch.receiptFile, config: f.launch.config, configSha256: launch.configSha256, controlRoot: launch.controlRoot,
      tokenFile: f.launch.tokenFile, evidence: join(launch.controlRoot, 'evidence.json'), trialId: 'trial', timeoutMs: 2000, scheduleOverride: 'disabled' };
    const host = { accept: async () => ({ state: 'accepted', acceptance_id: receiptFixture().acceptance_id }), wakeReceipt: async () => receiptFixture(),
      activityV2: async () => activityFixture(), availability: async () => ({ state: 'running', agents: [{ agent_id: 'agent:writer' }] }),
      stop: async () => ({ state: 'stopped' }) } as unknown as NativeHost;
    expect(() => createWorkerController(host, config, options, 'unit-token')).toThrow('Grok broker launch receipt');
    await mkdir(join(f.root, 'runtime/telemetry'), { recursive: true });
    await writeFile(join(f.root, 'runtime/telemetry/turns.ndjson'), `${JSON.stringify(traceFixture())}\n`);
    await mkdir(join(f.root, 'runtime/.codex/sessions'), { recursive: true });
    await writeFile(join(f.root, 'runtime/.codex/sessions/foreign.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } })}\n`);
    await writeFile(launch.broker.usageLedgerPath, `${JSON.stringify(usage)}\n${JSON.stringify(usage)}\n`);
    const result = await createWorkerController(host, config, options, 'unit-token', launch).run('wake', 'Assigned work');
    expect(result).toMatchObject({ status: 'completed', model: 'grok-4.6', engine: 'grok', reasoningEffort: 'low' });
    expect(result.native.usage).toEqual([usage]);
    expect(result.native.requests).toEqual([]);
    expect(result.coverage.find(row => row.channel === 'usage')?.completeness).toBe('complete');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Grok limit failures report only the closed broker limit reason', () => {
  const failed: NativeTrace = { ...traceFixture(), status: 'failed', error: { message: 'engine broker turn failed (limit_exceeded; limit=requests; worker/exit; exit=1; signal=null)' } };
  const receipt = { ...receiptFixture(), state: 'failed' as const };
  expect(describeNativeFailure(receipt, failed)).toBe('Native execution failed: Grok broker turn limit_exceeded (limit_reason requests)');
  const row = { ...usage, limit_reason: 'tokens' } as NativeGrokUsage;
  expect(describeNativeFailure(receipt, { ...failed, error: { message: 'private upstream words' } }, [row])).toBe('Native execution failed: Grok broker turn limit_exceeded (limit_reason tokens)');
  expect(describeNativeFailure(receipt, { ...failed, error: { message: 'private upstream words' } }, [{ ...row, limit_reason: 'none' }])).toBe('Native execution failed (delivery failed)');
  expect(describeNativeFailure(receipt, { ...failed, error: { message: 'engine broker turn failed (limit_exceeded; limit=secret)' } })).toBe('Native execution failed (delivery failed)');
  expect(describeNativeFailure(receipt, { ...failed, error: { message: 'Codex wake exceeded its 10-token per-wake ceiling (turn usage 12 tokens)' } }))
    .toBe('Native execution failed: Codex wake exceeded its 10-token per-wake ceiling (turn usage 12 tokens)');
});
