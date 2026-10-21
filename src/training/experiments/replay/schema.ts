import { createAtomicGradeResultSchema } from '../../graders/atomic/index.js';
import { validateCandidate, type CandidateManifest } from '../../candidates/index.js';
import { z } from 'zod';
import { decisionAccountingSchema, createGradeResultSchema } from '../../graders/index.js';
import { subjectUsageMatchesNative } from './subject-usage.js';
import { judgeFailureCauses, type EvaluationResult } from '../../contracts/evaluation.js';

const identity = z.string().min(1).max(512).refine(value => !value.includes('\0'));
const verdict = z.enum(['pass', 'fail', 'unknown', 'error', 'skipped']);
const coverage = z.object({ channel: z.enum(['tools', 'output', 'usage']),
  completeness: z.enum(['complete', 'partial', 'absent']), ordering: z.enum(['source', 'causal', 'none']) });
const usage = z.object({ inputTokens: z.number().nonnegative().nullable(), cachedInputTokens: z.number().nonnegative().nullable(),
  cacheWriteInputTokens: z.number().nonnegative().nullable().optional(),
  cacheWrite5mInputTokens: z.number().nonnegative().nullable().optional(),
  cacheWrite1hInputTokens: z.number().nonnegative().nullable().optional(),
  outputTokens: z.number().nonnegative().nullable(), reasoningTokens: z.number().nonnegative().nullable(),
  notionalUsd: z.number().nonnegative().finite().nullable().optional(), source: z.string() });
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const subjectUsage = z.object({ status: z.enum(['complete', 'incomplete']), usage: usage.extend({
  inputTokens: tokenCount, cachedInputTokens: tokenCount, outputTokens: tokenCount, reasoningTokens: tokenCount,
  cacheWriteInputTokens: tokenCount.optional(), cacheWrite5mInputTokens: tokenCount.optional(), cacheWrite1hInputTokens: tokenCount.optional(),
  source: z.string().min(1),
}).nullable(), settled: z.boolean().optional() });
const judgeCall = z.object({ id: identity, judge: identity, providerId: identity, requestedModel: identity,
  failureDetail: z.literal('tool-call').optional(),
  failureKind: z.enum(['quota', 'transport', 'unavailable', 'authentication', 'auth-stale', 'protocol', 'invalid-response', 'cancelled', 'timeout', 'unsupported', 'unknown']).optional(),
  fallbackOf: identity.optional(), wallMs: z.number().finite().nonnegative().optional(),
  billing: z.enum(['local', 'subscription', 'api', 'mixed']).optional(),
  citationRepairs: z.union([z.literal(0), z.literal(1)]).optional(), repairOf: identity.optional(),
  // Preserve historical retry provenance without attesting that earlier calls aborted.
  retryOf: identity.optional(), retryCause: z.enum(judgeFailureCauses).optional(),
  responseModel: z.string().nullable(), responseRoute: z.string().nullable(),
  outcome: z.enum(['completed', 'invalid-response', 'generation-error', 'refused']), usage: usage.nullable() });
const stop = z.object({ state: z.enum(['requested', 'acknowledged', 'unknown']), scope: z.enum(['process', 'process-group', 'native-handle']),
  quiescence: z.enum(['confirmed', 'unknown']), remoteWork: z.literal('unknown'), reason: z.string(), detail: z.string(),
  // A replayed report has to keep WHICH closure proof failed: the object schema
  // strips what it does not declare, and silently dropping the cause here would
  // put the diagnosis back where it was before the vocabulary existed.
  unconfirmed: z.enum(['worker-unavailable', 'terminal-absent', 'terminal-unbound', 'delivery-undisposed',
    'activity-unreadable', 'activity-busy', 'execution-unbound', 'native-stop-unacknowledged',
    'child-running', 'child-exit']).optional(),
  // And WHY a provably closed run could not be scored, which is a different
  // statement from an unproven closure and is dropped just as silently.
  unevidenced: z.enum(['terminal-absent', 'terminal-unbound', 'terminal-ambiguous']).optional(),
  // And WHICH wake a scored multi-wake trial was read from, with every wake's own
  // verdict beside it: a replayed report that kept only the trial-level name could
  // no longer say that the continuation failed after the assignment had bound.
  evidenced: identity.optional(),
  wakes: z.array(z.object({ wakeId: identity,
    unevidenced: z.enum(['terminal-absent', 'terminal-unbound', 'terminal-ambiguous']).optional() })).optional() });
// A replayed report has to keep WHY a judge errored for the same reason it keeps
// which closure proof failed: the object schema strips what it does not declare.
const judgeFailure = z.object({ cause: z.enum(judgeFailureCauses), judge: identity,
  providerId: z.string().nullable(), requestedModel: z.string().nullable(),
  responseModel: z.string().nullable(), responseRoute: z.string().nullable(),
  kind: z.enum(['quota', 'transport', 'unavailable', 'authentication', 'auth-stale', 'protocol',
    'invalid-response', 'cancelled', 'timeout', 'unsupported', 'unknown']).optional(),
  status: z.number().int().positive().max(599).optional() });
const result: z.ZodType<EvaluationResult> = z.lazy(() => z.object({ id: z.string().optional(), status: verdict,
  finality: z.enum(['provisional', 'final']), reason: z.string(), judgeFailure: judgeFailure.optional(),
  score: z.number().min(0).max(1).optional(),
  evidence: z.array(z.object({ kind: z.enum(['event', 'artifact', 'input', 'output', 'sidecar']), id: z.string(), digest: z.string().optional() })),
  cache: z.object({ key: z.string(), sourceCallId: z.string(), sourceCalls: z.array(judgeCall).optional() }).optional(),
  grading: createGradeResultSchema(judgeCall).optional(),
  atomicGrading: createAtomicGradeResultSchema(judgeCall).optional(),
  atomicFailure: z.object({ cause: z.literal('acceptance-gate'), gateId: identity }).optional(),
  decisionAccounting: decisionAccountingSchema.optional(),
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
  subjectUsage: subjectUsage.optional(), coverage: z.array(coverage), output: z.string(), inputFiles: z.record(z.string(), z.string()), context: z.record(z.string(), z.json()),
  artifacts: z.record(z.string(), z.object({ name: z.string(), checkpointId: z.string(), digest: z.string(), bytes: z.string(),
    value: z.json(), provenance: z.string(), acceptedCallId: z.string().optional() })) });

/** Version-one reports contain only a final snapshot; turn results do not imply turn snapshots. */
const declaredLimit = z.enum(['tokens', 'requests', 'timeout']);
export const trialReportSchema = z.object({
  schema: z.literal('paideia.trial.v1'), id: identity, phase: z.enum(['train', 'validation', 'test']), candidateId: identity,
  datasetDigest: identity, planDigest: identity, recordId: identity,
  candidate: z.custom<CandidateManifest>(value => {
    try { validateCandidate(value as CandidateManifest); return true; } catch { return false; }
  }, 'Invalid evaluated candidate manifest').optional(),
  round: z.number().int().nonnegative().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  subject: z.object({ adapterId: identity, requestedModel: identity, isolation: z.string() }).optional(),
  paths: z.object({ root: z.string(), workspace: z.string(), control: z.string(), runtimeHome: z.string() }),
  status: verdict, preDeferralStatus: verdict.optional(),
  failureKind: z.enum(['native-infrastructure', 'behavioral', 'measurement']).optional(),
  collectionFailed: z.literal(true).optional(),
  execution: z.enum(['completed', 'deferred', 'limit-exceeded', 'interrupted', 'failed']), limit: declaredLimit.optional(), hostWork: z.enum(['settled', 'incomplete']), snapshot,
  expectedTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  turns: z.array(z.object({ id: identity, checks: z.array(result), native: z.object({
    status: z.enum(['completed', 'failed', 'cancelled']), blocked: z.literal('awaiting-external-input').optional(),
    limit: declaredLimit.optional(), admission: z.object({ executionRecords: tokenCount, executionsUsed: tokenCount, agentExecutionsUsed: tokenCount,
      tokensUsed: tokenCount, agentTokensUsed: tokenCount, toolEvents: tokenCount, outputEvents: tokenCount }).strict().optional(),
    text: z.string(), coverage: z.array(coverage), usage: usage.nullable(),
    error: z.string().optional(), stop: stop.optional() }) })),
  evaluation: plan, live: z.array(z.object({ checkId: z.string(), boundary: z.string(), result })),
  decisiveFailure: result.optional(), stop: stop.optional(), error: z.string().optional(),
}).superRefine((report, context) => {
  if (report.candidate && report.candidate.id !== report.candidateId) {
    context.addIssue({ code: 'custom', path: ['candidate'], message: 'Evaluated candidate identity mismatch' });
  }
  if (report.phase === 'test' && report.round !== undefined) {
    context.addIssue({ code: 'custom', path: ['round'], message: 'Sealed tests have no search round' });
  }
  if (!subjectUsageMatchesNative(report)) {
    context.addIssue({ code: 'custom', path: ['snapshot', 'subjectUsage'], message: 'Subject usage does not match authoritative native totals and closure' });
  }
});
