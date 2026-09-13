import type { ResolvedDataset, Stage } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationRegistry, PlanEvaluation, Verdict } from '../../contracts/evaluation.js';
import type { ExperimentStore, ReadAccess } from '../../storage/index.js';
import type { TrialReport } from '../trials/index.js';

export interface RescoreOptions {
  store: ExperimentStore;
  runId: string;
  access: ReadAccess;
  dataset: ResolvedDataset;
  registry: EvaluationRegistry;
  evaluation: Pick<EvaluationContext, 'judges' | 'embeddings' | 'readText'>;
  /** Unique immutable evaluation identity, supplied explicitly by the caller. */
  id: string;
  signal?: AbortSignal;
}

export interface RescoreReport {
  schema: 'paideia.rescore.v1';
  id: string;
  runId: string;
  scope: 'final-stages';
  /** Live policies are historical evidence; no checkpoints or turn snapshots are invented. */
  notReevaluated: readonly ['live', 'per-turn'];
  original: {
    evaluationId: string;
    digest: string;
    candidateId: string;
    datasetDigest: string;
    planDigest: string;
    recordId: string;
    phase: TrialReport['phase'];
    status: Verdict;
  };
  criteria: {
    datasetId: string;
    datasetDigest: string;
    sharedPlanDigest: string;
    /** Exact resolved final-stage criteria, covered by the immutable rescore record digest. */
    stages: readonly Stage[];
    registryVersions: Readonly<Record<string, string>>;
    sidecarDigests: Readonly<Record<string, string>>;
    /** Configured routes, not a claim every route was invoked or its version attested. */
    inferenceRoutes: {
      judges: Readonly<Record<string, { providerId: string; model: string }>>;
      embeddings: Readonly<Record<string, { providerId: string; version: string }>>;
    };
  };
  execution: TrialReport['execution'];
  hostWork: TrialReport['hostWork'];
  coverage: TrialReport['snapshot']['coverage'];
  decisiveFailure?: TrialReport['decisiveFailure'];
  stop?: TrialReport['stop'];
  error?: string;
  /** Preserves execution/stop gates; evaluation.status describes only the new criteria. */
  status: Verdict;
  evaluation: PlanEvaluation;
}
