import { describe, expect, it } from 'vitest';
import { standardPrices } from './catalog.js';
import { valueUsage } from './valuation.js';
import type { ModelPrice, UsageCharge } from './types.js';

const usage = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100, reasoningTokens: 30, source: 'observed' };
const charge = (patch: Partial<UsageCharge> = {}): UsageCharge => ({ role: 'subject', name: 'writer', model: 'gpt-5.5',
  billing: 'subscription', contextTier: 'standard', usage, ...patch });
const fable = (patch: Partial<NonNullable<UsageCharge['usage']>> = {}) => charge({ model: 'claude-fable-5-1', usage: { ...usage, ...patch } });

describe('API-equivalent valuation', () => {
  it('prices cached input separately, never adds reasoning or assigns subscription cash charges', () => {
    const result = valueUsage(charge());
    expect(result.status).toBe('priced');
    expect(result.apiEquivalentUsd).toEqual({ low: 0.0044, high: 0.0044 });
    expect(result).not.toHaveProperty('actualBillUsd');
    expect(valueUsage(charge({ billing: 'api' }))).toEqual(result);
    expect(result.price).toMatchObject({ checkedAt: '2026-09-13', source: expect.stringContaining('developers.openai.com') });
  });
  it('prices observed cache-write duration and preserves unknown duration as a range', () => {
    const exact = valueUsage(fable({ cacheWriteInputTokens: 100, cacheWrite5mInputTokens: 80, cacheWrite1hInputTokens: 20 }));
    expect(exact.apiEquivalentUsd).toEqual({ low: 0.0076, high: 0.0076 });
    expect(valueUsage(fable({ cacheWriteInputTokens: 100 })).apiEquivalentUsd).toEqual({ low: 0.00745, high: 0.0082 });
    expect(valueUsage(fable({ cacheWriteInputTokens: 0 })).apiEquivalentUsd).toEqual({ low: 0.0072, high: 0.0072 });
  });
  it('does not treat missing cache observations as zero', () => {
    expect(valueUsage(fable()).apiEquivalentUsd).toEqual({ low: 0.0072, high: 0.0092 });
    expect(valueUsage(fable({ cachedInputTokens: null, cacheWriteInputTokens: 100 })).apiEquivalentUsd)
      .toEqual({ low: 0.006475, high: 0.016 });
    expect(valueUsage(charge({ usage: { ...usage, cachedInputTokens: null } })).apiEquivalentUsd)
      .toEqual({ low: 0.0035, high: 0.008 });
    expect(valueUsage(fable({ cachedInputTokens: null })).apiEquivalentUsd).toEqual({ low: 0.00525, high: 0.025 });
  });
  it('distinguishes session context tiers from aggregate token totals', () => {
    expect(valueUsage(charge({ contextTier: 'long' })).apiEquivalentUsd).toEqual({ low: 0.0073, high: 0.0073 });
    expect(valueUsage(charge({ contextTier: undefined })).apiEquivalentUsd).toEqual({ low: 0.0044, high: 0.0073 });
    expect(valueUsage(charge({ model: 'gpt-5.5-2026-04-23' })).apiEquivalentUsd).toEqual({ low: 0.0044, high: 0.0044 });
  });
  it('marks missing models or usage honestly', () => {
    expect(valueUsage(charge({ model: 'gpt-unknown' }))).toMatchObject({ status: 'unpriced', apiEquivalentUsd: null });
    for (const missing of [null, { ...usage, inputTokens: null }, { ...usage, outputTokens: null }]) {
      expect(valueUsage(charge({ usage: missing }))).toMatchObject({ status: 'incomplete', apiEquivalentUsd: null });
    }
    expect(valueUsage(charge({ usage: { ...usage, cachedInputTokens: 0, cacheWriteInputTokens: 10 } })))
      .toMatchObject({ status: 'incomplete', apiEquivalentUsd: null });
  });
  it.each([
    { inputTokens: -1 }, { inputTokens: 1.5 }, { inputTokens: Infinity }, { outputTokens: NaN },
    { cachedInputTokens: 1001 }, { cacheWriteInputTokens: 201 }, { reasoningTokens: 101 },
    { cacheWriteInputTokens: 10, cacheWrite5mInputTokens: 8, cacheWrite1hInputTokens: 5 },
    { cacheWriteInputTokens: 0, cacheWrite5mInputTokens: 1, cacheWrite1hInputTokens: 0 },
  ])('rejects impossible token accounting %j', patch => {
    expect(() => valueUsage(fable(patch))).toThrow();
  });
  it('rejects ambiguous, invalid and overflowing rate catalogs', () => {
    const price = standardPrices[0]!;
    expect(() => valueUsage(charge(), [price, price])).toThrow('Ambiguous');
    for (const patch of [{ input: -1 }, { input: Infinity }, { cacheRead: 6 }, { cacheWrite5m: 1 }]) {
      expect(() => valueUsage(charge(), [{ ...price, perMillion: { ...price.perMillion, ...patch } }])).toThrow();
    }
    expect(() => valueUsage(charge({ contextTier: 'long' }), [{ ...price,
      longContext: { aboveInputTokens: 10, inputMultiplier: 0, outputMultiplier: 2 } }])).toThrow('multiplier');
    expect(() => valueUsage(charge(), [{ ...price, perMillion: { input: 1e308, cacheRead: 0, output: 1e308 } }])).toThrow('overflow');
  });
  it('allows explicit one-duration catalogs without pretending a missing duration is known', () => {
    const price: ModelPrice = { ...standardPrices[2]!, perMillion: { input: 10, cacheRead: 1, cacheWrite5m: 12.5, output: 50 } };
    expect(valueUsage(fable({ cacheWriteInputTokens: 100, cacheWrite5mInputTokens: 100, cacheWrite1hInputTokens: 0 }), [price])
      .apiEquivalentUsd).toEqual({ low: 0.00805, high: 0.00805 });
    for (const patch of [
      { cacheWriteInputTokens: 100, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 100 },
      { cacheWriteInputTokens: 100 }, {},
    ]) expect(valueUsage(fable(patch), [price])).toMatchObject({ status: 'incomplete', apiEquivalentUsd: null });
    const longOnly: ModelPrice = { ...price, perMillion: { input: 10, cacheRead: 1, cacheWrite1h: 20, output: 50 } };
    expect(valueUsage(fable({ cacheWriteInputTokens: 100, cacheWrite5mInputTokens: 100, cacheWrite1hInputTokens: 0 }), [longOnly]))
      .toMatchObject({ status: 'incomplete', apiEquivalentUsd: null });
    expect(valueUsage(fable({ cacheWriteInputTokens: 100, cacheWrite5mInputTokens: 0, cacheWrite1hInputTokens: 100 }), [longOnly])
      .apiEquivalentUsd).toEqual({ low: 0.0088, high: 0.0088 });
  });
});
