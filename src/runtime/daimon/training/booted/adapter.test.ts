import { expect, test } from 'vitest';
import type { Observation } from '../../../../training/index.js';
import { createDaimonBootedAdapter, quotaFailure, timeoutFailure, type BootedTrialLauncher, type BootedWake } from './index.js';

const row = { input: 100, cache_read: 40, output: 5, notional_usd: 0.01, complete: true };
const wake = (overrides: Partial<BootedWake> = {}): BootedWake => ({
  state: 'completed', acceptanceId: 'a-1', executionId: 'e-1', code: null, text: 'pong', usage: [row], transcript: '{"t":1}', ...overrides,
});

const launcher = (wakes: BootedWake[], log: string[]): BootedTrialLauncher => ({
  boot: async ({ trialId, instructions }) => {
    log.push(`boot ${trialId} ${instructions}`);
    return {
      wake: async (text, options) => { log.push(`wake ${options.deliveryId} ${text}`); return wakes.shift()!; },
      read: async () => null,
      teardown: async () => { log.push('teardown'); },
    };
  },
});

const start = async (wakes: BootedWake[], log: string[], observations: Observation[] = []) =>
  createDaimonBootedAdapter({ launcher: launcher(wakes, log), timeoutMs: 1_000 }).start({
    trialId: 't-1', workspacePath: '/w', runtimeHomePath: '/h', instructions: 'be terse', onObservation: (value) => { observations.push(value); },
  });

test('boots one organization per trial, wakes it per turn and reports the runtime evidence', async () => {
  const log: string[] = [], observations: Observation[] = [];
  const session = await start([wake(), wake({ usage: [row, { ...row, complete: false }] })], log, observations);
  const first = await session.run({ id: 'turn-1', text: 'Reply with the word pong.' });
  expect(first).toMatchObject({ status: 'completed', text: 'pong',
    usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 5, reasoningTokens: null, source: 'daimon-turn-usage-ledger' },
    evidence: { adapterId: 'daimon-booted', payload: { acceptanceId: 'a-1', executionId: 'e-1', state: 'completed' } } });
  expect(first.coverage.find((entry) => entry.channel === 'usage')?.completeness).toBe('complete');
  expect(observations.map((value) => value.type)).toEqual(['output', 'usage', 'diagnostic']);
  const second = await session.run({ id: 'turn-2', text: 'again' });
  expect(second.usage?.inputTokens).toBe(200);
  expect(second.coverage.find((entry) => entry.channel === 'usage')?.completeness).toBe('partial');
  expect(await session.stop('done')).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  await session.stop('again');
  expect(log).toEqual(['boot t-1 be terse', 'wake t-1:turn-1 Reply with the word pong.', 'wake t-1:turn-2 again', 'teardown']);
  await expect(session.run({ id: 'turn-3', text: 'late' })).rejects.toThrow('already stopped');
});

test('ends the turn when the subject defers its delivery, and fails it when a failure deferred it', async () => {
  const session = await start([wake({ state: 'deferred', text: 'Deferred: missing row' }), wake({ state: 'deferred', code: 'engine_failed' })], []);
  expect(await session.run({ id: 'turn-1', text: 'x' })).toMatchObject({ status: 'completed', text: 'Deferred: missing row',
    evidence: { payload: { state: 'deferred' } } });
  expect(await session.run({ id: 'turn-2', text: 'x' })).toMatchObject({ status: 'failed', error: 'trial wake deferred (engine_failed)' });
});

test('never invents usage or success', async () => {
  const session = await start([wake({ state: 'timeout', text: '', usage: [], transcript: null }), wake({ state: 'stopped', code: 'host_stopped' })], []);
  const timedOut = await session.run({ id: 'turn-1', text: 'x' });
  expect(timedOut).toMatchObject({ status: 'failed', usage: null, error: 'trial wake timeout' });
  expect(timedOut.coverage.find((entry) => entry.channel === 'usage')?.completeness).toBe('absent');
  expect(await session.run({ id: 'turn-2', text: 'x' })).toMatchObject({ status: 'cancelled', error: 'trial wake stopped (host_stopped)' });
});

test('reports an unconfirmed stop when teardown fails', async () => {
  const session = await createDaimonBootedAdapter({ timeoutMs: 1, launcher: { boot: async () => ({
    wake: async () => wake(), read: async () => null, teardown: async () => { throw new Error('docker gone'); } }) } })
    .start({ trialId: 't', workspacePath: '/w', runtimeHomePath: '/h', instructions: 'i', onObservation: () => undefined });
  expect(await session.stop('done')).toMatchObject({ state: 'unknown', quiescence: 'unknown', detail: 'docker gone' });
});

test('boots from the record moment and collects declared outputs from the trial, plus the reply', async () => {
  const booted: unknown[] = [];
  const session = await createDaimonBootedAdapter({ timeoutMs: 1, launcher: { boot: async (input) => {
    booted.push(input.moment);
    return { wake: async () => wake({ text: 'filed' }), teardown: async () => undefined,
      read: async (path) => path === 'state/filing.json' ? '{"headline":"h"}' : null };
  } } }).start({ trialId: 't', workspacePath: '/w', runtimeHomePath: '/h', instructions: 'i', setup: { moment: { at: 'x' } },
    onObservation: () => undefined });
  expect(booted).toEqual([{ at: 'x' }]);
  expect(await session.collect!({ output: 'state/filing.json', missing: 'nope.json' })).toEqual({
    output: { bytes: '{"headline":"h"}', provenance: 'trial-workspace:state/filing.json' } });
  await session.run({ id: 'turn-1', text: 'x' });
  const final = await session.collect!({ output: 'state/filing.json' });
  expect(final.reply).toEqual({ bytes: 'filed', provenance: 'trial-reply' });
  // After the trial stops its container is gone: the last reading stands as the final collection.
  await session.stop('done');
  expect(await session.collect!({ output: 'state/filing.json' })).toEqual(final);
});

// What Daimon reported for the slice C AGY trial: the CLI's JSON stdout, elided in the middle, quota error at the end.
const AGY_QUOTA = 'engine_failed: CLI engine exited 1: {"event":"init","conversation_id":"44ff69fd","init":{"tools":["ask_permission"]}[… 3274 bytes elided …]'
  + 'conversation_id":"44ff69fd","status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 95h51m47s.","num_turns":1}}';

test('a delivery Daimon deferred after the engine refused on quota is a failed quota turn, never the subject deferring', async () => {
  const session = await start([wake({ state: 'deferred', executionId: null, text: '', usage: [], failure: AGY_QUOTA }),
    wake({ state: 'deferred', text: 'Deferred: missing row', failure: 'engine_failed: CLI engine exited 1' })], []);
  // Mutation guard: before the failure was read, this turn was graded as the subject's own deferral.
  expect(await session.run({ id: 'turn-1', text: 'x' })).toMatchObject({ status: 'failed', failure: 'quota',
    error: 'trial wake deferred: subscription quota: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 95h51m47s.' });
  // Any other failure Daimon deferred is still a failed turn: Daimon deferred it, the subject did not.
  const other = await session.run({ id: 'turn-2', text: 'x' });
  expect(other).toMatchObject({ status: 'failed', error: 'trial wake deferred: engine_failed: CLI engine exited 1' });
  expect(other.limit).toBeUndefined();
});

// What Daimon relayed for the slice C Grok variant: both 30 minute turns sealed by the broker's wall-clock bound.
const GROK_TIMEOUT = 'engine_failed: engine broker turn failed (limit_exceeded; limit=timeout; mcp=41/41 answered)';
// Its usage row: Grok's `input` is the fresh prompt only, cached reads sit beside it in their own bucket.
const grokRow = { input: 1_279_022, cache_read: 4_771_712, output: 266_795, total: 1_279_022 + 4_771_712 + 266_795, notional_usd: 0, complete: false };

// An AGY turn killed at its clock (Daimon 0.2.20+): the finished steps metered from its stream, after the one retry.
const AGY_TIMEOUT = 'engine_failed: CLI engine timed out';
const agyRow = { input: 29_658, cache_read: 0, output: 368, total: 30_026, notional_usd: 0, complete: false };

test('an AGY turn killed at its clock after metered steps is a declared timeout, scored', async () => {
  const session = await start([wake({ state: 'deferred', executionId: null, text: '', usage: [agyRow], failure: AGY_TIMEOUT })], []);
  expect(await session.run({ id: 'turn-1', text: 'x' })).toMatchObject({ status: 'failed', limit: 'timeout', usage: { outputTokens: 368 } });
});

test('a turn killed at its wall-clock bound while the model worked is a declared timeout, scored; a hang is not', async () => {
  const session = await start([wake({ state: 'deferred', executionId: null, text: '', usage: [grokRow], failure: GROK_TIMEOUT }),
    wake({ state: 'deferred', executionId: null, text: '', usage: [], failure: GROK_TIMEOUT }),
    wake({ state: 'failed', text: '', usage: [{ ...row, output: 0 }], failure: 'engine_failed: Codex wake exceeded its 1800000ms per-wake wall-clock bound' }),
    wake({ state: 'failed', text: '', usage: [row], failure: 'engine_failed: CLI engine exited 1' })], []);
  // Mutation guard: before this, Daimon's deferral read as the subject's own and every filing check was unknown.
  const worked = await session.run({ id: 'turn-1', text: 'x' });
  expect(worked).toMatchObject({ status: 'failed', limit: 'timeout', usage: { outputTokens: 266_795 },
    error: 'trial wake deferred: wall-clock bound reached while the subject was working' });
  // No measured model work: an infrastructure hang, never the subject's score.
  for (const id of ['turn-2', 'turn-3']) {
    const hung = await session.run({ id, text: 'x' });
    expect(hung.status).toBe('failed'); expect(hung.limit).toBeUndefined();
  }
  // A failure that is not the wall-clock bound is never labelled a timeout.
  expect((await session.run({ id: 'turn-4', text: 'x' })).limit).toBeUndefined();
  // Its usage is counted whole (cached reads are a subset of input, as the core requires to settle the turn).
  expect(worked.usage).toMatchObject({ inputTokens: 1_279_022 + 4_771_712, cachedInputTokens: 4_771_712 });
});

test('reads every engine\'s prompt tokens whole, whether cached reads are inside input or beside it', async () => {
  const session = await start([wake({ usage: [{ ...row, total: 105 }] }), wake({ usage: [grokRow] })], []);
  expect((await session.run({ id: 'turn-1', text: 'x' })).usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 40 });
  // Mutation guard: reading a disjoint `input` as the whole put cached reads above it and the core dropped the usage.
  const disjoint = await session.run({ id: 'turn-2', text: 'x' });
  expect(disjoint.usage).toMatchObject({ inputTokens: 6_050_734, cachedInputTokens: 4_771_712 });
});

test('classifies wall-clock bound wording engine-neutrally, and nothing else', () => {
  for (const text of [GROK_TIMEOUT, 'engine_failed: CLI engine timed out', 'Codex wake exceeded its 5ms per-wake wall-clock bound'])
    expect(timeoutFailure(text)).toBe(true);
  for (const text of ['engine broker turn failed (limit_exceeded; limit=tokens)', 'engine_failed: CLI engine exited 1', '', null, undefined])
    expect(timeoutFailure(text)).toBe(false);
});

test('classifies quota and rate-limit wording engine-neutrally, and nothing else', () => {
  for (const text of ['429 Too Many Requests', "You've hit your usage limit. Try again later.", 'rate limited by provider', 'Rate-limit exceeded'])
    expect(quotaFailure(text)).toBeDefined();
  for (const text of ['engine broker turn limit reached', 'CLI engine timed out', 'do not use quotation marks', '', null, undefined])
    expect(quotaFailure(text)).toBeUndefined();
});

test('hands the whole runtime failure text over and names its reason in the error, never a bare state', async () => {
  const long = `engine_failed: CLI engine exited with code 1: ${'stream closed before a reply. '.repeat(40)}end of account`;
  const session = await start([wake({ state: 'deferred', failure: long, text: '' }), wake({ state: 'failed', code: 'engine_failed', failure: 'engine_failed: model\n  refused the request' })], []);
  const deferred = await session.run({ id: 'turn-1', text: 'x' });
  expect(deferred.failureText).toBe(long);
  expect(deferred.error).toMatch(/^trial wake deferred: engine_failed: CLI engine exited with code 1: stream closed/u);
  expect(deferred.error!.length).toBeLessThan(450);
  expect(await session.run({ id: 'turn-2', text: 'x' })).toMatchObject({ status: 'failed', failureText: 'engine_failed: model\n  refused the request',
    error: 'trial wake failed (engine_failed): engine_failed: model refused the request' });
});

test('explains a wake still open at the trial deadline by its failed execution without scoring it as a declared limit', async () => {
  const session = await start([wake({ state: 'timeout', text: '', failure: 'engine_failed: CLI engine timed out after 2700000ms' })], []);
  const result = await session.run({ id: 'turn-1', text: 'x' });
  expect(result).toMatchObject({ status: 'failed', failureText: 'engine_failed: CLI engine timed out after 2700000ms',
    error: 'trial wake timeout: engine_failed: CLI engine timed out after 2700000ms' });
  expect(result.limit).toBeUndefined();
  expect(result.failure).toBeUndefined();
});

test('gives the launcher the trial evidence directory and keeps no failure text on a completed turn', async () => {
  const seen: unknown[] = [];
  const session = await createDaimonBootedAdapter({ timeoutMs: 1_000, launcher: { boot: async (input) => {
    seen.push(input.evidenceDirectory);
    return { wake: async () => wake({ failure: 'stale text from an earlier failed execution' }), read: async () => null, teardown: async () => undefined };
  } } }).start({ trialId: 't-1', workspacePath: '/w', runtimeHomePath: '/h', evidencePath: '/trial/evidence', instructions: 'i', onObservation: () => undefined });
  expect(seen).toEqual(['/trial/evidence']);
  expect((await session.run({ id: 'turn-1', text: 'x' })).failureText).toBeUndefined();
});

test('names the failure the runtime still reported at teardown in the stop receipt of a turn cut short', async () => {
  const session = await createDaimonBootedAdapter({ timeoutMs: 1_000, launcher: { boot: async () => ({
    wake: async () => wake(), read: async () => null, teardown: async () => 'engine_failed: CLI engine exited with code 1' }) } })
    .start({ trialId: 't-1', workspacePath: '/w', runtimeHomePath: '/h', instructions: 'i', onObservation: () => undefined });
  expect(await session.stop('Trial deadline exceeded')).toMatchObject({ state: 'acknowledged',
    detail: 'trial organization container removed; last runtime failure: engine_failed: CLI engine exited with code 1' });
});
