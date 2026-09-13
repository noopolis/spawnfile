import type { CheckNode, EvaluatorDefinition, DataMap } from './dataset.js';
import type { Observation, ObservationCoverage, InferenceProvider, Usage } from './execution.js';

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
}
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
export interface EvaluationSnapshot {
  trialId: string;
  recordId: string;
  closed: boolean;
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
  judges: Readonly<Record<string, { provider: InferenceProvider; model: string }>>;
  embeddings: Readonly<Record<string, EmbeddingProvider>>;
  /** The host confines sidecars to protected evaluator resources. */
  readText: (path: string) => Promise<string>;
  signal?: AbortSignal;
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
}
export interface PlanEvaluation {
  status: Verdict;
  stages: StageEvaluation[];
  checks: Record<string, EvaluationResult>;
  scores: Record<string, WeightedScore>;
  judgeCalls?: JudgeCall[];
}
