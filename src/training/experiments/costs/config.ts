import { z } from 'zod';
import { resolveCostAssumptions } from './assumptions.js';
import { standardPrices } from './catalog.js';
import type { CostAssumptions, ModelPrice } from './types.js';

const rate = z.number().nonnegative().finite();
const price = z.object({ model: z.string().min(1), vendor: z.string().min(1), currency: z.literal('USD'),
  perMillion: z.object({ input: rate, cacheRead: rate, output: rate, cacheWrite5m: rate.optional(), cacheWrite1h: rate.optional() }).strict(),
  source: z.string().min(1), checkedAt: z.iso.date(), scope: z.string().min(1),
  longContext: z.object({ aboveInputTokens: z.number().int().positive(), inputMultiplier: z.number().min(1), outputMultiplier: z.number().min(1) }).strict().optional(),
}).strict();
const schema = z.object({ schema: z.literal('paideia.cost-config.v1'), assumptions: z.unknown().optional(),
  prices: z.array(price).optional() }).strict();

/** Explicit per-model overrides; no alias guessing and no network price refresh. */
export function resolveCostConfig(value?: unknown): { assumptions: CostAssumptions; prices: ModelPrice[] } {
  const config = value === undefined ? undefined : schema.parse(value);
  const overrides = config?.prices ?? [];
  if (new Set(overrides.map(entry => entry.model)).size !== overrides.length) throw new Error('Duplicate cost model override');
  return { assumptions: resolveCostAssumptions(config?.assumptions),
    prices: structuredClone([...standardPrices.filter(entry => !overrides.some(override => override.model === entry.model)), ...overrides]) };
}
