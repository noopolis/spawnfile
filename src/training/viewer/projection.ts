import { z } from 'zod';
import type { ViewerCheck, ViewerData } from './types.js';

const text = z.string().max(16384);
const id = text.min(1);
const count = z.number().int().nonnegative();
const score = z.number().min(0).max(1).nullable();
const strings = z.array(id).max(1000);
const range = z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() })
  .refine(value => value.high >= value.low, 'Invalid cost range');
const price = z.object({ checkedAt: text, source: z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Price links must use HTTPS without credentials').nullable() }).nullable();
const costTokens = z.object({ inputTokens: count.nullable(), cachedInputTokens: count.nullable(),
  cacheWriteInputTokens: count.nullable(), cacheWrite5mInputTokens: count.nullable(), cacheWrite1hInputTokens: count.nullable(),
  outputTokens: count.nullable(), reasoningTokens: count.nullable(), invalid: z.boolean() }).nullable();
const costs = z.object({
  planned: z.object({ total: range.nullable(), knownSubtotal: range, coverage: z.enum(['estimated', 'partial']),
    lines: z.array(z.object({ role: id, name: text, phase: id, model: text, provider: text.nullable(),
      plannedCalls: count, amount: range.nullable(), price })).max(1000) }).optional(),
  observed: z.object({ total: range.nullable(), knownSubtotal: range, completeness: z.enum(['complete', 'incomplete']),
    usageCoverage: z.enum(['observed-only', 'incomplete']),
    groups: z.array(z.object({ role: id, name: text, entryCount: count, amount: range.nullable(), knownSubtotal: range })).max(1000),
    lines: z.array(z.object({ role: id, name: text, model: text.nullable(), requestedModel: text.nullable(),
      modelBasis: z.enum(['provider-reported', 'requested-assumption', 'unknown']),
      provider: text.nullable(), route: text.nullable(), outcome: id, usage: costTokens, valuationStatus: id,
      amount: range.nullable(), price })).max(1000) }).optional(),
});
const check: z.ZodType<ViewerCheck> = z.lazy(() => z.object({
  weight: z.number().finite().nonnegative().optional(), weightedContribution: z.number().min(0).max(1).nullable().optional(),
  id, label: text, status: z.enum(['pass', 'fail', 'unknown', 'error', 'skipped']), score,
  evidenceIds: strings, children: z.array(check).max(1000),
}));
const schema = z.object({
  schema: z.literal('paideia.viewer.v1'),
  experiment: z.object({ id, title: text, status: id,
    phase: z.enum(['evaluation', 'train', 'validation', 'final-test', 'replay']), updatedAt: text }),
  cases: z.array(z.object({ id, split: z.enum(['train', 'validation', 'test']), label: text.optional() })).max(1000),
  trials: z.array(z.object({
    id, caseId: id, candidateId: id, status: id, score,
    coverage: z.array(z.object({ channel: z.enum(['tools', 'output', 'usage']),
      completeness: z.enum(['complete', 'partial', 'absent']), ordering: z.enum(['source', 'causal', 'none']) })).max(3),
    checks: z.array(check).max(1000),
    events: z.array(z.object({ id, type: id, timestamp: text, summary: text })).max(1000),
  })).max(1000),
  candidates: z.array(z.object({ id, label: text.optional(), nativeId: id.optional(), parentIds: strings, validationScore: score,
    discoveryEvaluations: count, editablePaths: strings })).max(1000),
  usage: z.array(z.object({ purpose: z.enum(['subject', 'optimizer', 'judge', 'embedding']),
    model: text.nullable(), modelBasis: z.enum(['provider-reported', 'requested-assumption']).optional(), route: text.nullable(), usage: z.object({
      inputTokens: count.nullable(), cachedInputTokens: count.nullable(), outputTokens: count.nullable(),
      reasoningTokens: count.nullable(), source: id,
      cacheWriteInputTokens: count.nullable().optional(), cacheWrite5mInputTokens: count.nullable().optional(),
      cacheWrite1hInputTokens: count.nullable().optional(),
    }).nullable() })).max(1000),
  optimizer: z.object({ name: id, status: id, evaluations: count, proposals: count,
  maxMetricCalls: count, maxProposals: count, selectedCandidateId: id.optional() }).optional(),
  costs: costs.optional(),
  activity: z.object({ trialId: id, caseId: id, phase: z.enum(['train', 'validation', 'test']), status: id,
    toolCalls: count, judgeCalls: count, measurements: z.array(z.object({stageId:id,criterionId:id,
      kind:z.enum(['criterion','gate','score']),status:id,score,
      weight:z.number().finite().nonnegative().optional(),weightedContribution:score.optional()})).max(1000),
  }).optional(),
});

/** Strip undeclared fields, bound check trees and reject invalid projections. */
export function projectViewerData(input: ViewerData): ViewerData {
  if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new Error('Viewer projection exceeds 8 MiB');
  const pending = input.trials.flatMap((trial) => trial.checks.map((value) => ({ value, depth: 0 })));
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 5000 || depth > 24) throw new Error('Viewer check tree exceeds its display bounds');
    pending.push(...value.children.map((child) => ({ value: child, depth: depth + 1 })));
  }
  const data = schema.parse(input);
  const candidateIds = new Set(data.candidates.map((candidate) => candidate.id));
  if (candidateIds.size !== data.candidates.length
      || data.candidates.some((candidate) => candidate.parentIds.includes(candidate.id))) {
    throw new Error('Viewer candidate identities must be unique without self-parent relationships');
  }
  return data;
}
