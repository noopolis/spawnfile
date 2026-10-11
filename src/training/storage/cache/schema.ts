import { z } from 'zod';
import { parseDocument } from 'yaml';
import { judgeFailureCauses, type CachedJudgment } from '../../contracts/evaluation.js';

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
  wallMs: z.number().finite().nonnegative().optional(),
  billing: z.enum(['local', 'subscription', 'api', 'mixed']).optional(),
  citationRepairs: z.union([z.literal(0), z.literal(1)]).optional(),
  repairOf: z.string().optional(), fallbackOf: z.string().optional(),
  retryOf: z.string().optional(), retryCause: z.enum(judgeFailureCauses).optional(),
  failureKind: z.enum(['quota', 'transport', 'unavailable', 'authentication', 'auth-stale', 'protocol', 'invalid-response',
    'cancelled', 'timeout', 'unsupported', 'unknown']).optional(),
}).strict();
const entry = z.object({ response: z.string().min(1), sourceCallId: z.string().min(1),
  sourceCalls: z.array(call).min(1).max(64) }).strict();
const citationJudgment = z.object({ score: z.number().min(0).max(1), verdict: z.enum(['pass', 'fail']),
  reasons: z.array(z.string().min(1)).min(1), citations: z.array(z.object({
    source: z.string().min(1), quote: z.string().min(1),
  }).strict()).min(1) }).strict();

const evidenceJudgment = z.object({ score: z.number().min(0).max(1), verdict: z.enum(['pass', 'fail']),
  reasons: z.array(z.string().min(1).max(240)).min(1).max(3),
  evidenceIds: z.array(z.string().regex(/^e-[a-f0-9]{20}$/u)).min(1).max(8)
    .refine(ids => new Set(ids).size === ids.length, 'Evidence IDs must be unique'),
}).strict();
const judgment = z.union([citationJudgment, evidenceJudgment]);

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
      (attempt.retryOf && !ids.has(attempt.retryOf)) ||
      (attempt.fallbackOf && !ids.has(attempt.fallbackOf))) throw new Error('Invalid cached attempt chain');
    ids.add(attempt.id);
  }
  let response: unknown;
  try { response = JSON.parse(parsed.data.response); }
  catch { throw new Error('Invalid cached judgment JSON'); }
  if (parseDocument(parsed.data.response, { uniqueKeys: true }).errors.length || !judgment.safeParse(response).success) throw new Error('Invalid cached judgment response');
  return parsed.data;
}
