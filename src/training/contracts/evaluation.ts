import type { CheckNode, EvaluatorDefinition, DataMap } from './dataset.js';
import type { Observation, ObservationCoverage, InferenceProvider, Usage, InferenceFailureKind } from './execution.js';

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
  identity?: string;
  template?: { language: 'jinja'; text: string };
  cache?: JudgeCache;
  /** Host-frozen dataset and phase identity, required for persistent reuse. */
  cacheScope?: string;
}
export interface JudgeProtocolViolation {
  code: 'invalid-json' | 'invalid-judgment' | 'invalid-citations' | 'invalid-citation-repair';
  citations?: { index: number; source: string; reason: 'unknown-source' | 'quote-not-found' }[];
}
/** Protected evaluator evidence, never part of optimizer feedback or viewer projections. */
export interface JudgeAttemptObservation { call: JudgeCall; response: string; violation?: JudgeProtocolViolation }
export interface EvaluationResult {
  id?: string;
  status: Verdict;
  finality: Finality;
  reason: string;
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
}
export interface EvaluationMeasurement {
  stageId: string;
  criterionId: string;
  kind: 'criterion' | 'gate' | 'score';
  status: Verdict;
  score: number | null;
  weight?: number;
  weightedContribution?: number | null;
}
export interface RegisteredEvaluator {
  definition: EvaluatorDefinition;
  evaluate(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult>;
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
