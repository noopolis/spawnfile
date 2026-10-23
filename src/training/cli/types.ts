import type { InferenceProviderRegistry } from '../contracts/inference-registry.js';
import type { GraderDependencies } from './grader/index.js';
import type { TrainingModel } from '../contracts/training-config.js';
import type { InferenceGrantAuthority, InferenceProvider, SubjectAdapter } from '../contracts/index.js';
import type { BlobReference } from '../storage/index.js';
import type { DatasetRegistry, EditPolicy, NativePreparationContext, StoredTrialOptions } from '../index.js';
import type { TrainingMomentPreparation } from './spawnfile/moments.js';
import type { SpawnfileTrainingContext } from './spawnfile/index.js';
import type { SubjectAdapterRegistry } from '../subjects/index.js';

/** Adapter-owned durable experiment services, passed unchanged to integration hooks. */
export type NativeTrialServices = Readonly<Record<string, unknown>>;

export interface CliIO {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  signal?: AbortSignal;
}

/** Tests inject only the native/inference boundaries; experiment/storage code stays real. */
export interface CliDependencies {
  inferenceProviders?: InferenceProviderRegistry;
  subjects?: SubjectAdapterRegistry;
  /** Runtime composition supplies durable native services; the core treats their keys as opaque. */
  createTrialServices?: (stateRoot: string) => NativeTrialServices;
  /** Canonical host context, validated against pinned source bytes without a temporary receipt file. */
  spawnfileContext?: SpawnfileTrainingContext;
  grader?: GraderDependencies;
  /** Container integrations may bind internally; the launcher must publish only on host loopback. */
  viewerBindHost?: '127.0.0.1' | '0.0.0.0';
  adapter?: (runtime: string, options: { model: string; timeoutMs: number }) => SubjectAdapter;
  inference?: (timeoutMs: number) => InferenceProvider;
  modelInference?: (model: TrainingModel, timeoutMs: number) => InferenceProvider;
  /** Broker-grant authority seam; defaults to the injected subject capability over the container control socket. */
  grantAuthority?: () => Promise<InferenceGrantAuthority>;
  /** Trusted project composition. Registration is static; native factory runs only after preflight. */
  spawnfile?: SpawnfileCliIntegration;
}

export interface CliExecutionIdentityContext {
  /** Content identity of the frozen authored replacement; no optimizer bridge in comparison mode. */
  comparisonCandidateId?: string;
  /** Exact normalized optimizer bridge launch; absent for authored comparison. */
  bridge?: Readonly<{ command: string; cwd: string }>;
}

export interface SpawnfileCliIntegration {
  id: string;
  version: string;
  /** Native scratch path inside the launch environment; never an evaluator root. */
  subjectRoot?: string;
  /** Trusted immutable inference image + invocation-policy identity; omitted means ambient host execution. */
  readonly inferenceExecutionIdentity?: string;
  /** Existing canonical writable cache base; relative YAML directories resolve beneath it in this execution. */
  readonly judgeCacheRoot?: string;
  preparations?: DatasetRegistry['preparations'];
  unlockedSetupPaths?: readonly string[];
  /** Named trusted hooks re-materialize authored cases into fresh per-trial state. */
  momentPreparations?: Readonly<Record<string, TrainingMomentPreparation>>;
  /** Narrows explicitly selected editable files to their declared sections. Cannot unlock identity. */
  editPolicies?: Readonly<Record<string, EditPolicy>>;
  /** Resolved public optimizer and optional hard boundaries (max 50, each 1..500 characters).
   * YAML declarations must match; local configuration only, no execution. */
  trainingOptimizer?(context: SpawnfileTrainingContext): Promise<{
    method: 'gepa'; model: string; variants: number; keep: number; budget: { rounds: number }; boundaries?: string[];
  } | undefined>;
  /** Hash of immutable preparation/image/tool/evidence inputs; excludes credentials and generated state. */
  executionIdentity?: (context: CliExecutionIdentityContext) => string | Promise<string>;
  createAdapter(context: SpawnfileTrainingContext, options: { model: string; timeoutMs: number } & NativeTrialServices): SubjectAdapter;
  prepareEnvironment(paths: Parameters<NonNullable<StoredTrialOptions['prepareEnvironment']>>[0], signal: AbortSignal,
    trial: NativePreparationContext, context: SpawnfileTrainingContext, services: NativeTrialServices): ReturnType<NonNullable<StoredTrialOptions['prepareEnvironment']>>;
}

export interface InvocationIndex {
  schema: 'spawnfile.training.invocation.v1';
  /** Absent for existing completed invocations. Failure never releases sealed tests. */
  outcome?: 'failed';
  command: 'evaluate' | 'train';
  summaryRunId: string;
  phase: 'train' | 'test';
  candidateId: string;
  trialIds: string[];
  report: BlobReference;
  candidate: BlobReference;
  /** Immutable completed operator export; never exposed through optimizer blob access. */
  trainingExport?: { directory: string; markdown: string; json: string };
}
