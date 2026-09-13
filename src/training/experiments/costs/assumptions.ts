import { z } from 'zod';
import type { CostAssumptions } from './types.js';

const range = z.object({ low: z.number().int().nonnegative().max(1e9), high: z.number().int().nonnegative().max(1e9) })
  .strict().refine(value => value.low <= value.high, 'Range low must not exceed high');
const fraction = z.object({ low: z.number().min(0).max(1), high: z.number().min(0).max(1) })
  .strict().refine(value => value.low <= value.high, 'Range low must not exceed high');
const tokens = z.object({ inputTokens: range, outputTokens: range, cacheReadFraction: fraction }).strict();
const schema = z.object({ subject: tokens.optional(), judge: tokens.optional(), optimizer: tokens.optional(),
  judges: z.record(z.string().min(1), tokens).optional() }).strict();

/** Broad uncalibrated planning ranges per complete trial / inference call, not measured limits. */
export const defaultCostAssumptions: CostAssumptions = {
  subject: { inputTokens: { low: 10000, high: 250000 }, outputTokens: { low: 2000, high: 16000 }, cacheReadFraction: { low: 0, high: 0.8 } },
  judge: { inputTokens: { low: 2000, high: 32000 }, outputTokens: { low: 200, high: 2000 }, cacheReadFraction: { low: 0, high: 0.5 } },
  optimizer: { inputTokens: { low: 8000, high: 64000 }, outputTokens: { low: 500, high: 8000 }, cacheReadFraction: { low: 0, high: 0.5 } },
};

export function resolveCostAssumptions(input: unknown = {}): CostAssumptions {
  return structuredClone({ ...defaultCostAssumptions, ...schema.parse(input) });
}
