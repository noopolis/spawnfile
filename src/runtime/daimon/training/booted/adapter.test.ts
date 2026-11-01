import { expect, test } from 'vitest';
import type { Observation } from '../../../../training/index.js';
import { createDaimonBootedAdapter, type BootedTrialLauncher, type BootedWake } from './index.js';

const row = { input: 100, cache_read: 40, output: 5, notional_usd: 0.01, complete: true };
const wake = (overrides: Partial<BootedWake> = {}): BootedWake => ({
  state: 'completed', acceptanceId: 'a-1', executionId: 'e-1', code: null, text: 'pong', usage: [row], transcript: '{"t":1}', ...overrides,
});

const launcher = (wakes: BootedWake[], log: string[]): BootedTrialLauncher => ({
  boot: async ({ trialId, instructions }) => {
    log.push(`boot ${trialId} ${instructions}`);
    return {
      wake: async (text, options) => { log.push(`wake ${options.deliveryId} ${text}`); return wakes.shift()!; },
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

test('never invents usage or success', async () => {
  const session = await start([wake({ state: 'timeout', text: '', usage: [], transcript: null }), wake({ state: 'stopped', code: 'host_stopped' })], []);
  const timedOut = await session.run({ id: 'turn-1', text: 'x' });
  expect(timedOut).toMatchObject({ status: 'failed', usage: null, error: 'trial wake timeout' });
  expect(timedOut.coverage.find((entry) => entry.channel === 'usage')?.completeness).toBe('absent');
  expect(await session.run({ id: 'turn-2', text: 'x' })).toMatchObject({ status: 'cancelled', error: 'trial wake stopped (host_stopped)' });
});

test('reports an unconfirmed stop when teardown fails', async () => {
  const session = await createDaimonBootedAdapter({ timeoutMs: 1, launcher: { boot: async () => ({
    wake: async () => wake(), teardown: async () => { throw new Error('docker gone'); } }) } })
    .start({ trialId: 't', workspacePath: '/w', runtimeHomePath: '/h', instructions: 'i', onObservation: () => undefined });
  expect(await session.stop('done')).toMatchObject({ state: 'unknown', quiescence: 'unknown', detail: 'docker gone' });
});
