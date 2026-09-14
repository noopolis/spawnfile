import { expect, it } from 'vitest';
import type { Usage } from '../../contracts/execution.js';
import { summarizeCosts } from '../costs/index.js';
import { runTrial } from './trial.js';
import { complete, setup } from './fixture.js';

const usage: Usage = { inputTokens: 2000, cachedInputTokens: 1000, cacheWriteInputTokens: 0,
  outputTokens: 20, reasoningTokens: null, source: 'synthetic-native-total' };

it('retains and persists a returned native result before a post-turn collector fails', async () => {
  const native = { ...complete, usage, coverage: [...complete.coverage,
    { channel: 'usage' as const, completeness: 'complete' as const, ordering: 'source' as const }] };
  const task = await setup(async () => native);
  task.options.prepare = async () => ({ instructions: 'original instructions', collect: async () => { throw new Error('Receipt rejected'); } });
  const report = await runTrial(task.options);
  expect(report.execution).toBe('failed');
  expect(report.snapshot.subjectUsage).toEqual({ status: 'incomplete', usage });
  expect(report.turns).toHaveLength(1);
  expect(report.turns[0]!.native).toEqual(native);
  expect(task.journal.find(row => row.type === 'turn.native-result')?.payload).toEqual({ id: 'task', native });
  expect(report.snapshot.coverage).toContainEqual(native.coverage[2]);
  expect(summarizeCosts([report], { subjectModel: 'unknown-test-model' }).entries[0]!.usage).toEqual(usage);
});

it.each(['throw', 'failed-return'] as const)('preserves usage observed before collector rejection and native %s', async outcome => {
  const task = await setup(async (input, turn) => {
    try {
      await input.onObservation({ id: 'observed-total', source: 'synthetic-native', seq: 1, type: 'usage', usage,
        trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() });
    } catch (error) {
      if (outcome === 'throw') throw error;
      return { ...complete, status: 'failed', usage: null, error: String(error) };
    }
    throw new Error('Collector must have rejected the observation');
  });
  task.options.prepare = async () => ({ instructions: 'original instructions', collect: async () => { throw new Error('Receipt rejected'); } });
  const report = await runTrial(task.options);
  expect(report.execution).toBe('failed');
  expect(report.snapshot.events).toHaveLength(1);
  expect(report.snapshot.subjectUsage).toEqual({ status: 'incomplete', usage: null });
  expect(report.snapshot.events[0]!.usage).toEqual(usage);
  expect(task.journal.some(row => row.type === 'observation')).toBe(true);
  const costs = summarizeCosts([report], { subjectModel: 'unknown-test-model' });
  expect(costs.entries).toHaveLength(1);
  expect(costs.entries[0]!.usage).toEqual(usage);
  expect(costs.completeness).toBe('incomplete');
  expect(costs.apiEquivalentUsd).toBeNull();
});
