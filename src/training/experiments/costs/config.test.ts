import { expect, it } from 'vitest';
import { resolveCostConfig } from './config.js';
import { resolveCostAssumptions } from './assumptions.js';
import { standardPrices } from './catalog.js';

it('has independent explicit defaults and exact model overrides', () => {
  const result = resolveCostConfig();
  result.assumptions.subject.inputTokens.high = 7;
  result.prices[0]!.perMillion.input = 99;
  expect(resolveCostConfig().assumptions.subject.inputTokens.high).toBe(250000);
  expect(standardPrices[0]!.perMillion.input).toBe(5);
  const override = { ...standardPrices[0]!, perMillion: { input: 7, cacheRead: 0.7, output: 10 }, source: 'operator calibration' };
  expect(resolveCostConfig({ schema: 'paideia.cost-config.v1', prices: [override] }).prices.filter(p => p.model === 'gpt-5.5')).toEqual([override]);
  expect(resolveCostConfig({ schema: 'paideia.cost-config.v1' }).prices).toEqual(standardPrices);
});

it('rejects unknown fields, duplicate prices and inverted or invalid assumptions', () => {
  for (const value of [{}, { schema: 'paideia.cost-config.v1', mystery: true },
    { schema: 'paideia.cost-config.v1', prices: [standardPrices[0], standardPrices[0]] }]) expect(() => resolveCostConfig(value)).toThrow();
  const tokens = resolveCostAssumptions().judge;
  for (const patch of [{ inputTokens: { low: 100, high: 10 } }, { outputTokens: { low: 0.5, high: 2 } },
    { cacheReadFraction: { low: 0.8, high: 0.2 } }, { cacheReadFraction: { low: 0, high: 2 } }]) {
    expect(() => resolveCostAssumptions({ judge: { ...tokens, ...patch } })).toThrow();
  }
  expect(resolveCostAssumptions({ judges: { prose: tokens } }).judges?.prose).toEqual(tokens);
});
