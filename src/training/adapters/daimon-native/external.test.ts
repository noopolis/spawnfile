import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { nextExternalInput, sumNativeUsage, weakestNativeCoverage, type NativeExternalInputs } from './external.js';
const text = 'Answer';
const input = { id: 'reply', text, source: { kind: 'fixture', id: 'reply', sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } };
const context = {} as Parameters<NativeExternalInputs['next']>[0];
test('checks source identity, timeout and cancellation without accepting late callbacks', async () => {
  const policy = { maxDeliveries: 1, next: async () => input };
  expect(await nextExternalInput(policy, context, Date.now() + 1000, new AbortController().signal)).toEqual(input);
  expect(await nextExternalInput({ ...policy, next: async () => null }, context, Date.now() + 1000, new AbortController().signal)).toBeNull();
  await expect(nextExternalInput(policy, context, Date.now() - 1, new AbortController().signal)).rejects.toThrow('deadline');
  await expect(nextExternalInput(policy, context, Date.now() + 1000, AbortSignal.abort())).rejects.toThrow('cancelled');
  await expect(nextExternalInput({ ...policy, next: async () => ({ ...input, id: '' }) }, context, Date.now() + 1000, new AbortController().signal)).rejects.toThrow('Invalid');
  let observed: AbortSignal | undefined;
  const hanging = { ...policy, next: async (_context: typeof context, signal: AbortSignal): Promise<null> => { observed = signal; return new Promise(() => undefined); } };
  await expect(nextExternalInput(hanging, context, Date.now() + 10, new AbortController().signal)).rejects.toThrow('deadline');
  expect(observed?.aborted).toBe(true);
  const controller = new AbortController();
  const pending = nextExternalInput(hanging, context, Date.now() + 1000, controller.signal); controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
});
test('sums independent wake usage once and preserves unknowns', () => {
  const row = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, reasoningTokens: null, source: 'native' };
  expect(sumNativeUsage([{ ...row, reasoningTokens: 1 }])).toEqual({ ...row, reasoningTokens: 1 });
  expect(sumNativeUsage([row, row])).toMatchObject({ inputTokens: 20, outputTokens: 4, cachedInputTokens: 6 });
  expect(sumNativeUsage([])).toBeNull(); expect(sumNativeUsage([null])).toBeNull();
  expect(sumNativeUsage([{ ...row, inputTokens: null }])?.inputTokens).toBeNull();
  expect(() => sumNativeUsage([{ ...row, inputTokens: -1 }])).toThrow('Invalid');
  expect(sumNativeUsage([row, row])).toEqual({ inputTokens: 20, outputTokens: 4, cachedInputTokens: 6, reasoningTokens: null, source: 'noopolis.daimon.turn-usage.v1' });
  const grok = { ...row, cacheWriteInputTokens: 1, notionalUsd: 0.25 };
  expect(sumNativeUsage([grok, grok])).toMatchObject({ inputTokens: 20, cacheWriteInputTokens: 2, notionalUsd: 0.5 });
  expect(sumNativeUsage([grok, { ...grok, cacheWriteInputTokens: null, notionalUsd: undefined }])).toMatchObject({ cacheWriteInputTokens: null, notionalUsd: null });
});


test('coverage preserves the weakest wake and never upgrades missing observations', () => {
  expect(weakestNativeCoverage([])).toEqual([]);
  expect(weakestNativeCoverage([[{ channel: 'usage', completeness: 'partial', ordering: 'source' }],
    [{ channel: 'usage', completeness: 'complete', ordering: 'causal' }]])).toEqual([{ channel: 'usage', completeness: 'partial', ordering: 'source' }]);
  expect(weakestNativeCoverage([[{ channel: 'usage', completeness: 'complete', ordering: 'causal' }], undefined]))
    .toEqual([{ channel: 'usage', completeness: 'absent', ordering: 'none' }]);
  expect(weakestNativeCoverage([[{ channel: 'usage', completeness: 'complete', ordering: 'causal' }]]))
    .toEqual([{ channel: 'usage', completeness: 'complete', ordering: 'causal' }]);
  expect(weakestNativeCoverage([[{ channel: 'usage', completeness: 'absent', ordering: 'none' }]]))
    .toEqual([{ channel: 'usage', completeness: 'absent', ordering: 'none' }]);
});
