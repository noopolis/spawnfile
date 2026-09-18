import type { CheckNode, EvaluatorDefinition, DataMap } from './dataset.js';
import type { Observation, ObservationCoverage, InferenceProvider, Usage, InferenceFailureKind, InferenceDiagnostic } from './execution.js';

export type Verdict = 'pass' | 'fail' | 'unknown' | 'error' | 'skipped';
export type Finality = 'provisional' | 'final';
export interface EvidenceReference { kind: 'event' | 'artifact' | 'input' | 'output' | 'sidecar'; id: string; digest?: string }
export interface JudgeCall {
  /** One actual provider.generate attempt; references retain this ID for deduplication. */
  id: string;
  judge: string;
  providerId: string;
  requestedModel: string;
  /** Must be a provider-reported identity; requested-model fallbacks and missing identities are null. */
  responseModel: string | null;
  responseRoute: string | null;
  outcome: 'completed' | 'invalid-response' | 'generation-error';
  usage: Usage | null;
  /** Configured maximum, including when no repair was needed. Omitted only in legacy captures. */
  citationRepairs?: 0 | 1;
  /** A citation-only protocol repair of this earlier actual attempt. */
  repairOf?: string;
  failureKind?: InferenceFailureKind;
  fallbackOf?: string;
}
export interface CachedJudgment {
  response: string;
  sourceCallId: string;
  /** Historical inference provenance, never current inference or billable usage. */
  sourceCalls?: JudgeCall[];
}
/** Host-owned, bounded evaluation cache; no subject access and no infrastructure errors. */
export interface JudgeCache {
  readonly persistent?: boolean;
  get(key: string): CachedJudgment | undefined | Promise<CachedJudgment | undefined>;
  put(key: string, value: CachedJudgment): void | Promise<void>;
}
export interface JudgeRoute {
  provider: InferenceProvider;
  model: string;
  citationRepairs?: 0 | 1;
  protocol?: 'citations' | 'evidence-ids';
  identity?: string;
  template?: { language: 'jinja'; text: string };
  cache?: JudgeCache;
  /** Host-frozen dataset and phase identity, required for persistent reuse. */
  cacheScope?: string;
}
/**
 * Why a judge produced no usable judgment, as a closed vocabulary rather than prose.
 *
 * A judge error used to publish a bare `status: 'error'` and nothing else: the
 * reason string can quote the prompt, the article or a provider body, so nothing
 * carried it, and a live run left an operator unable to tell a refused grant from
 * an unreadable answer. These values name the FIRST thing that did not hold, and
 * never carry a prompt, subject text, a response body, a bearer or a grant token.
 *
 * Absence is not one of them. A judge with no input to read stays `unknown` with
 * no failure at all, which is a different claim from one that ran and refused.
 */
export const judgeFailureCauses = [
  /** The grant broker declined to lend a grant for this call. */
  'grant-refused',
  /** A grant, or the credential realm behind it, was no longer valid. */
  'grant-expired',
  /** The provider itself failed; `status` carries its reported status when it reported one. */
  'provider-error',
  /** The answer was not JSON at all. */
  'response-unparseable',
  /** The answer parsed but was not a judgment of the requested shape. */
  'response-schema',
  /** The judgment's citations were not present in the evidence it was given. */
  'response-citations',
  /** A deadline passed before an answer arrived. */
  'timeout',
  /** The caller cancelled the trial before the judge settled. */
  'cancelled',
  /** The judge route is absent or its declared policy is unusable; nothing was asked. */
  'route-unusable',
  /** The selected evidence could not be prepared for the judge; nothing was asked. */
  'evidence-unusable',
  /** A persisted judgment could not be read back as one. */
  'cache-unusable',
  /** The attempt could not be recorded, so its answer may not be accepted. */
  'evidence-unpersisted',
  /** The provider failed with no typed discriminator at all; naming that is still a finding. */
  'unclassified',
] as const;
export type JudgeFailureCause = (typeof judgeFailureCauses)[number];

/**
 * The published, prose-free account of one failed judge: the cause, which judge,
 * and which model and route actually answered. An unrequested provider or route
 * appearing here is how a silent judge fallback stops being silent.
 */
export interface JudgeFailure {
  cause: JudgeFailureCause;
  judge: string;
  providerId: string | null;
  requestedModel: string | null;
  /** Provider-reported; null when no provider identity was returned. Never a requested alias. */
  responseModel: string | null;
  responseRoute: string | null;
  kind?: InferenceFailureKind;
  /** Only a provider-reported response status, as a number. */
  status?: number;
}
export interface JudgeProtocolViolation {
  code: 'invalid-json' | 'invalid-judgment' | 'invalid-citations' | 'invalid-citation-repair' | 'invalid-evidence-ids';
  citations?: { index: number; source: string; reason: 'unknown-source' | 'quote-not-found' }[];
}
/** Protected evaluator evidence, never part of optimizer feedback or viewer projections. */
export interface JudgeAttemptObservation { call: JudgeCall; response: string; violation?: JudgeProtocolViolation; diagnostic?: InferenceDiagnostic }
export interface EvaluationResult {
  id?: string;
  status: Verdict;
  finality: Finality;
  reason: string;
  /** Set on every `error` a judge produces; absent on any other verdict. */
  judgeFailure?: JudgeFailure;
  score?: number;
  evidence: EvidenceReference[];
  children?: EvaluationResult[];
  usage?: Usage[];
  judgeCalls?: JudgeCall[];
  cache?: { key: string; sourceCallId: string; sourceCalls?: JudgeCall[] };
}
export interface ArtifactSnapshot {
  name: string;
  checkpointId: string;
  digest: string;
  bytes: string;
  value: unknown;
  provenance: string;
  acceptedCallId?: string;
}
/** Authoritative subject-only returned turn totals; never reconstructed from observations. */
export interface SubjectUsageSnapshot { status: 'complete' | 'incomplete'; usage: Usage | null }
export interface EvaluationSnapshot {
  trialId: string;
  recordId: string;
  closed: boolean;
  /** Missing in legacy captures means unknown, never zero cost. */
  subjectUsage?: SubjectUsageSnapshot;
  events: readonly Observation[];
  coverage: readonly ObservationCoverage[];
  artifacts: Readonly<Record<string, ArtifactSnapshot>>;
  output: string;
  inputFiles: Readonly<Record<string, string>>;
  context: Readonly<DataMap>;
}
export interface EmbeddingProvider {
  id: string;
  version: string;
  embed(texts: readonly string[], model: string, signal?: AbortSignal): Promise<{
    vectors: number[][]; usage: Usage | null;
  }>;
}
export interface EvaluationContext {
  snapshot: EvaluationSnapshot;
  results: Readonly<Record<string, EvaluationResult>>;
  scores: Readonly<Record<string, WeightedScore>>;
  judges: Readonly<Record<string, JudgeRoute>>;
  embeddings: Readonly<Record<string, EmbeddingProvider>>;
  /** The host confines sidecars to protected evaluator resources. */
  readText: (path: string) => Promise<string>;
  /** Trusted host sink, awaited before accepting a judgment or making its one permitted repair. */
  observeJudgeAttempt?: (attempt: JudgeAttemptObservation) => void | Promise<void>;
  /** Trusted persisted measurement sink; never receives prompt text or judge reasons. */
  observeMeasurement?: (measurement: EvaluationMeasurement) => void | Promise<void>;
  signal?: AbortSignal;
  /** Maximum slotted (inference-capable) stage checks in flight; built-in mechanical checks take no slot. Defaults to 2. */
  checkConcurrency?: number;
}
export interface EvaluationMeasurement {
  stageId: string;
  criterionId: string;
  kind: 'criterion' | 'gate' | 'score';
  status: Verdict;
  score: number | null;
  weight?: number;
  weightedContribution?: number | null;
  /** Named cause of an errored judge criterion; the weight still counts against the denominator. */
  judgeFailure?: JudgeFailure;
}
export interface RegisteredEvaluator {
  definition: EvaluatorDefinition;
  evaluate(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult>;
  /**
   * Opt-in stage concurrency. Declare only when the result never reads context.results or
   * context.scores; return the stateful resources it uses (for example a judge cache).
   * Checks sharing a resource never overlap. Results and measurements still commit in order.
   */
  concurrency?(check: CheckNode, context: EvaluationContext): readonly object[] | undefined;
}
export type EvaluationRegistry = Readonly<Record<string, RegisteredEvaluator>>;
export interface WeightedScore {
  finality: Finality;
  lower: number;
  upper: number;
  assessedWeight: number;
  missingWeight: number;
}
export interface StageEvaluation {
  id: string;
  checks: EvaluationResult[];
  gate: EvaluationResult;
  score?: WeightedScore;
  /** Authored relative weights; normalize against the complete declared denominator. */
  weights?: Record<string, number>;
}
export interface PlanEvaluation {
  status: Verdict;
  stages: StageEvaluation[];
  checks: Record<string, EvaluationResult>;
  scores: Record<string, WeightedScore>;
  judgeCalls?: JudgeCall[];
}
