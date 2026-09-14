import { z } from 'zod';
import type { EvaluationResult } from '../../contracts/evaluation.js';

const identity = z.string().min(1).max(512).refine(value => !value.includes('\0'));
const verdict = z.enum(['pass', 'fail', 'unknown', 'error', 'skipped']);
const coverage = z.object({ channel: z.enum(['tools', 'output', 'usage']),
  completeness: z.enum(['complete', 'partial', 'absent']), ordering: z.enum(['source', 'causal', 'none']) });
const usage = z.object({ inputTokens: z.number().nonnegative().nullable(), cachedInputTokens: z.number().nonnegative().nullable(),
  cacheWriteInputTokens: z.number().nonnegative().nullable().optional(),
  cacheWrite5mInputTokens: z.number().nonnegative().nullable().optional(),
  cacheWrite1hInputTokens: z.number().nonnegative().nullable().optional(),
  outputTokens: z.number().nonnegative().nullable(), reasoningTokens: z.number().nonnegative().nullable(), source: z.string() });
const judgeCall = z.object({ id: identity, judge: identity, providerId: identity, requestedModel: identity,
  failureKind: z.enum(['quota', 'transport', 'unavailable', 'authentication', 'protocol', 'cancelled', 'timeout', 'unsupported', 'unknown']).optional(),
  fallbackOf: identity.optional(),
  citationRepairs: z.union([z.literal(0), z.literal(1)]).optional(), repairOf: identity.optional(),
  responseModel: z.string().nullable(), responseRoute: z.string().nullable(),
  outcome: z.enum(['completed', 'invalid-response', 'generation-error']), usage: usage.nullable() });
const stop = z.object({ state: z.enum(['requested', 'acknowledged', 'unknown']), scope: z.enum(['process', 'process-group', 'native-handle']),
  quiescence: z.enum(['confirmed', 'unknown']), remoteWork: z.literal('unknown'), reason: z.string(), detail: z.string() });
const result: z.ZodType<EvaluationResult> = z.lazy(() => z.object({ id: z.string().optional(), status: verdict,
  finality: z.enum(['provisional', 'final']), reason: z.string(), score: z.number().min(0).max(1).optional(),
  evidence: z.array(z.object({ kind: z.enum(['event', 'artifact', 'input', 'output', 'sidecar']), id: z.string(), digest: z.string().optional() })),
  cache: z.object({ key: z.string(), sourceCallId: z.string(), sourceCalls: z.array(judgeCall).optional() }).optional(),
  children: z.array(result).optional(), usage: z.array(usage).optional(), judgeCalls: z.array(judgeCall).optional() }));
const weighted = z.object({ finality: z.enum(['provisional', 'final']), lower: z.number(), upper: z.number(),
  assessedWeight: z.number(), missingWeight: z.number() });
const plan = z.object({ status: verdict, stages: z.array(z.object({ id: z.string(), checks: z.array(result), gate: result,
  score: weighted.optional(), weights: z.record(z.string(), z.number().finite().nonnegative()).optional() })), checks: z.record(z.string(), result), scores: z.record(z.string(), weighted),
  judgeCalls: z.array(judgeCall).optional() });
const observation = z.object({ id: identity, source: identity, seq: z.number().int().nonnegative(),
  type: z.enum(['tool.dispatch', 'tool.complete', 'output', 'usage', 'diagnostic', 'input']), timestamp: z.string(),
  trialId: identity, wakeId: identity, callId: z.string().optional(), tool: z.string().optional(),
  args: z.unknown().optional(), result: z.unknown().optional(), success: z.boolean().optional(), text: z.string().optional(),
  usage: usage.optional(), causalParents: z.array(z.string()).optional(), native: z.unknown().optional() });
const snapshot = z.object({ trialId: identity, recordId: identity, closed: z.literal(true), events: z.array(observation),
  coverage: z.array(coverage), output: z.string(), inputFiles: z.record(z.string(), z.string()), context: z.record(z.string(), z.json()),
  artifacts: z.record(z.string(), z.object({ name: z.string(), checkpointId: z.string(), digest: z.string(), bytes: z.string(),
    value: z.json(), provenance: z.string(), acceptedCallId: z.string().optional() })) });

/** Version-one reports contain only a final snapshot; turn results do not imply turn snapshots. */
export const trialReportSchema = z.object({
  schema: z.literal('paideia.trial.v1'), id: identity, phase: z.enum(['train', 'validation', 'test']), candidateId: identity,
  datasetDigest: identity, planDigest: identity, recordId: identity,
  paths: z.object({ root: z.string(), workspace: z.string(), control: z.string(), runtimeHome: z.string() }),
  status: verdict, execution: z.enum(['completed', 'interrupted', 'failed']), hostWork: z.enum(['settled', 'incomplete']), snapshot,
  turns: z.array(z.object({ id: identity, checks: z.array(result), native: z.object({
    status: z.enum(['completed', 'failed', 'cancelled']), text: z.string(), coverage: z.array(coverage), usage: usage.nullable(),
    error: z.string().optional(), stop: stop.optional() }) })),
  evaluation: plan, live: z.array(z.object({ checkId: z.string(), boundary: z.string(), result })),
  decisiveFailure: result.optional(), stop: stop.optional(), error: z.string().optional(),
});
