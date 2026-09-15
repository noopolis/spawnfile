import type { TrainingModel } from '../contracts/training-config.js';
import type { InferenceProvider, SubjectAdapter } from '../contracts/index.js';
import type { BlobReference } from '../storage/index.js';
import type { DatasetRegistry, EditPolicy, NativePreparationContext, StoredTrialOptions } from '../index.js';
import type { SpawnfileTrainingContext } from './spawnfile/index.js';

export interface CliIO {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  signal?: AbortSignal;
}

/** Tests inject only the native/inference boundaries; experiment/storage code stays real. */
export interface CliDependencies {
  /** Container integrations may bind internally; the launcher must publish only on host loopback. */
  viewerBindHost?: '127.0.0.1' | '0.0.0.0';
  adapter?: (runtime: 'codex' | 'daimon', options: { model: string; timeoutMs: number }) => SubjectAdapter;
  inference?: (timeoutMs: number) => InferenceProvider;
  modelInference?: (model: TrainingModel, timeoutMs: number) => InferenceProvider;
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
  /** Narrows explicitly selected editable files to their declared sections. Cannot unlock identity. */
  editPolicies?: Readonly<Record<string, EditPolicy>>;
  /** Hash of immutable preparation/image/tool/evidence inputs; excludes credentials and generated state. */
  executionIdentity?: (context: CliExecutionIdentityContext) => string | Promise<string>;
  createAdapter(context: SpawnfileTrainingContext, options: { model: string; timeoutMs: number }): SubjectAdapter;
  prepareEnvironment(paths: Parameters<NonNullable<StoredTrialOptions['prepareEnvironment']>>[0], signal: AbortSignal,
    trial: NativePreparationContext, context: SpawnfileTrainingContext): ReturnType<NonNullable<StoredTrialOptions['prepareEnvironment']>>;
}

export interface InvocationIndex {
  schema: 'paideia.invocation.v1';
  /** Absent for existing completed invocations. Failure never releases sealed tests. */
  outcome?: 'failed';
  command: 'evaluate' | 'train';
  summaryRunId: string;
  phase: 'train' | 'test';
  candidateId: string;
  trialIds: string[];
  report: BlobReference;
  candidate: BlobReference;
}
