import { z } from 'zod';
import type { CachedJudgment } from '../../contracts/evaluation.js';

const token = z.number().int().nonnegative().nullable();
const usage = z.object({
  inputTokens: token, cachedInputTokens: token, outputTokens: token, reasoningTokens: token,
  cacheWriteInputTokens: token.optional(), cacheWrite5mInputTokens: token.optional(),
  cacheWrite1hInputTokens: token.optional(), source: z.string().min(1),
}).strict();
const call = z.object({
  id: z.string().min(1), judge: z.string().min(1), providerId: z.string().min(1), requestedModel: z.string().min(1),
  responseModel: z.string().nullable(), responseRoute: z.string().nullable(),
  outcome: z.enum(['completed', 'invalid-response', 'generation-error']), usage: usage.nullable(),
  citationRepairs: z.union([z.literal(0), z.literal(1)]).optional(),
  repairOf: z.string().optional(), fallbackOf: z.string().optional(),
  failureKind: z.enum(['quota', 'transport', 'unavailable', 'authentication', 'protocol',
    'cancelled', 'timeout', 'unsupported', 'unknown']).optional(),
}).strict();
const entry = z.object({ response: z.string().min(1), sourceCallId: z.string().min(1),
  sourceCalls: z.array(call).min(1).max(64) }).strict();
const judgment = z.object({ score: z.number().min(0).max(1), verdict: z.enum(['pass', 'fail']),
  reasons: z.array(z.string().min(1)).min(1), citations: z.array(z.object({
    source: z.string().min(1), quote: z.string().min(1),
  }).strict()).min(1) }).strict();

export function validateCachedJudgment(value: unknown): CachedJudgment {
  const parsed = entry.safeParse(value);
  if (!parsed.success) throw new Error('Invalid persistent judgment provenance');
  const last = parsed.data.sourceCalls.at(-1)!;
  if (last.id !== parsed.data.sourceCallId || last.outcome !== 'completed') {
    throw new Error('Persistent judgment must reference a completed inference');
  }
  const ids = new Set<string>();
  for (const attempt of parsed.data.sourceCalls) {
    if (ids.has(attempt.id) || (attempt.repairOf && !ids.has(attempt.repairOf)) ||
      (attempt.fallbackOf && !ids.has(attempt.fallbackOf))) throw new Error('Invalid cached attempt chain');
    ids.add(attempt.id);
  }
  let response: unknown;
  try { response = JSON.parse(parsed.data.response); }
  catch { throw new Error('Invalid cached judgment JSON'); }
  if (!judgment.safeParse(response).success) throw new Error('Invalid cached judgment response');
  return parsed.data;
}
