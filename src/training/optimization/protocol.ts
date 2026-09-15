import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { InferenceAttempt } from '../contracts/execution.js';

export const DSPY_SCHEMA = 'paideia.dspy.v1';
export const DSPY_FRAME_BYTES = 4 * 1024 * 1024;
const id = z.string().min(1).max(4096);
const count = z.number().int().nonnegative();
const modelBasis = z.enum(['provider-reported', 'requested-assumption']).optional();
export const componentsSchema = z.record(id, z.string().max(1024 * 1024))
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 64, 'Expected 1–64 components');
export const budgetSchema = z.object({
  maxMetricCalls: z.number().int().min(1).max(10000), maxProposals: z.number().int().min(1).max(1000),
}).strict();
export const proposalPolicySchema = z.object({
  strategy: z.enum(['refine', 'rewrite']).optional(), min_change: z.number().min(0).max(1).optional(),
  max_attempts: z.number().int().min(1).max(5).optional(), history_entries: z.number().int().min(1).max(100).optional(),
  history_bytes: z.number().int().min(1024).max(262144).optional(),
}).strict();
export const startSchema = z.object({
  schema: z.literal(DSPY_SCHEMA), kind: z.literal('optimize'), id, components: componentsSchema,
  trainCaseIds: z.array(id).min(1).max(10000), validationCaseIds: z.array(id).min(1).max(10000),
  recovery: z.object({ evaluations: count, proposals: count }).strict().optional(),
  checkpoint: z.object({ directory: id, identity: id, fork: z.object({ directory: id, identity: id, id,
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().optional() }).strict().optional(),
  proposal: proposalPolicySchema.optional(),
  budget: budgetSchema, seed: z.number().int().min(0).max(2 ** 32 - 1).default(0),
}).strict().superRefine((value, context) => {
  const train = new Set(value.trainCaseIds), validation = new Set(value.validationCaseIds);
  if (train.size !== value.trainCaseIds.length || validation.size !== value.validationCaseIds.length
      || value.trainCaseIds.some((caseId) => validation.has(caseId))) {
    context.addIssue({ code: 'custom', message: 'Training and validation IDs must be unique and disjoint' });
  }
  if (value.budget.maxMetricCalls < validation.size) {
    context.addIssue({ code: 'custom', message: 'Budget must cover complete baseline validation' });
  }
});
export const evaluationSchema = z.object({
  score: z.number().min(0).max(1), feedback: z.string(), output: z.string(), captureId: id,
}).strict();
export const usageSchema = z.object({
  inputTokens: count.nullable(), cachedInputTokens: count.nullable(), outputTokens: count.nullable(),
  cacheWriteInputTokens: count.nullable().optional(), cacheWrite5mInputTokens: count.nullable().optional(),
  cacheWrite1hInputTokens: count.nullable().optional(),
  reasoningTokens: count.nullable(), source: id,
}).strict().nullable();
const inferenceAttemptSchema = z.object({
  id, ordinal: z.number().int().positive(), providerId: id, requestedModel: id,
  responseModel: id.nullable(), responseRoute: id.nullable(),
  outcome: z.enum(['completed', 'failed']),
  failureKind: z.enum(['quota', 'transport', 'unavailable', 'authentication', 'protocol', 'invalid-response', 'cancelled', 'timeout', 'unsupported', 'unknown']).nullable(),
  startedAt: id, completedAt: id, usage: usageSchema,
}).strict();
/** Host-only evidence. Attempts never cross the strict Python response protocol. */
export const inferenceSchema = z.object({ text: z.string().min(1), model: id, usage: usageSchema, route: id, modelBasis,
  attempts: z.array(inferenceAttemptSchema).optional() }).strict();
export const evaluateParamsSchema = z.object({
  caseId: id, split: z.enum(['train', 'validation']), components: componentsSchema,
}).strict();
export const generateParamsSchema = z.object({
  purpose: z.literal('reflection'),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1),
  options: z.object({ responseSchema: z.record(z.string(), z.unknown()).optional() }).strict(),
}).strict();
const common = { schema: z.literal(DSPY_SCHEMA), id };
export const requestSchema = z.discriminatedUnion('method', [
  z.object({ ...common, kind: z.literal('request'), method: z.literal('evaluate'), params: evaluateParamsSchema }).strict(),
  z.object({ ...common, kind: z.literal('request'), method: z.literal('generate'), params: generateParamsSchema }).strict(),
]);
const captureSchema = z.object({ caseId: id, split: z.enum(['train', 'validation']), captureId: id }).strict();
export const resultSchema = z.object({
  ...common, kind: z.literal('result'), components: componentsSchema,
  provenance: z.object({
    optimizer: z.literal('dspy.GEPA'), dspyVersion: z.literal('3.3.1'), gepaVersion: z.literal('0.1.4'),
    seed: count, evaluations: count, proposals: count, selectedCandidateIndex: count,
    candidates: z.array(z.object({
      components: componentsSchema, parents: z.array(count.nullable()).min(1),
      validationScore: z.number().min(0).max(1), discoveryEvaluations: count,
    }).strict()).min(1),
    captures: z.array(captureSchema),
    generations: z.array(z.object({ model: id, usage: usageSchema, modelBasis }).strict()),
  }).strict(),
}).strict();
export const errorSchema = z.object({ ...common, kind: z.literal('error'),
  error: z.object({ code: id, message: z.string() }).strict(),
}).strict();
export const messageSchema = z.union([requestSchema, resultSchema, errorSchema]);
export type DspyStart = z.infer<typeof startSchema>;
export type DspyRequest = z.infer<typeof requestSchema>;
type DspyWireResult = z.infer<typeof resultSchema>;
/** Trusted host enrichment is added only after validating the unextended bridge result. */
export type DspyResult = Omit<DspyWireResult, 'provenance'> & {
  provenance: Omit<DspyWireResult['provenance'], 'generations'> & {
    generations: Array<DspyWireResult['provenance']['generations'][number] & { attempts?: readonly InferenceAttempt[] }>;
  };
};
export type DspyEvaluation = z.infer<typeof evaluationSchema>;
export type DspyEvaluateParams = z.infer<typeof evaluateParamsSchema>;
export type DspyGenerateParams = z.infer<typeof generateParamsSchema>;

export function encodeMessage(value: unknown): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > DSPY_FRAME_BYTES) throw new Error('DSPy JSONL frame exceeds its byte limit');
  return line;
}

export function decodeMessage(line: string): z.infer<typeof messageSchema> {
  if (Buffer.byteLength(line) + 1 > DSPY_FRAME_BYTES) throw new Error('DSPy JSONL frame exceeds its byte limit');
  const value: unknown = JSON.parse(line);
  // JSON.parse overwrites duplicate keys. The existing YAML parser supplies a
  // duplicate-key check after JSON syntax has already been required.
  if (parseDocument(line, { uniqueKeys: true }).errors.length > 0) throw new Error('DSPy JSONL has duplicate or invalid keys');
  return messageSchema.parse(value);
}

export function sameComponents(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
