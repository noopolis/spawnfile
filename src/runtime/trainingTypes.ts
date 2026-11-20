import type { ResolvedAuthProfile, SubscriptionRealmBinding } from "../auth/index.js";
import type { TrainingContext } from "../compiler/training/index.js";
import type { TrialCacheMode } from "../compiler/training/trial/index.js";
import type {
  InferenceProviderDescriptor, Observation, ObservationCoverage, StopReceipt, SubjectAdapter, SubjectAdapterRegistration,
  SubjectOutput, SubjectStart, Usage
} from "../training/index.js";

export type { InferenceProviderDescriptor, Observation, ObservationCoverage, StopReceipt, SubjectAdapter, SubjectOutput, SubjectStart, Usage };
import type { RuntimeTrainingGraderContribution, RuntimeTrainingInferenceContribution } from "./trainingProviderTypes.js";

export type { RuntimeTrainingGraderContribution, RuntimeTrainingInferenceContribution } from "./trainingProviderTypes.js";

export interface RuntimeTrainingStreams {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface TrainingRunControls {
  trialCache?: TrialCacheMode;
  cacheDir?: string;
  judgeConcurrency?: number;
  realmLock?: "wait" | "fail";
}

export interface RuntimeTrainingRunOptions {
  context: TrainingContext;
  args: readonly string[];
  dryRun: boolean;
  authProfile?: string;
  controls?: TrainingRunControls;
  timeoutMs: number;
  streams: RuntimeTrainingStreams;
  signal?: AbortSignal;
}

export interface RuntimeTrainingJudgeOptions extends TrainingRunControls {
  authProfile: string;
  out: string;
  streams: RuntimeTrainingStreams;
  signal?: AbortSignal;
}

export interface RuntimeTrainingLoginOptions {
  engine: string;
  profileName: string;
  dryRun?: boolean;
}

export interface RuntimeTrainingLoginResult {
  binding: SubscriptionRealmBinding;
  command: readonly string[];
  profile: ResolvedAuthProfile;
}

export interface TrainingCredentialOperations {
  stage?(source: string): Promise<string>;
  prepareAuthority?(source: string, dockerContext: string): Promise<string>;
  writeBack?(profile: string, candidate: string, journalFile: string): Promise<boolean>;
}

/** Admission is synchronous metadata, while native execution is loaded only when requested. */
export interface RuntimeTrainingCapability {
  adapterId?: string;
  engines?: readonly string[];
  subject?(): Promise<SubjectAdapterRegistration>;
  run?(options: RuntimeTrainingRunOptions): Promise<number>;
  openJudges?(options: RuntimeTrainingJudgeOptions): Promise<{ close(): Promise<void> }>;
  login?: {
    supportsEngine(engine: string): boolean;
    run(options: RuntimeTrainingLoginOptions): Promise<RuntimeTrainingLoginResult>;
  };
  loadInferenceProviders?(): Promise<RuntimeTrainingInferenceContribution>;
  loadGraderProviders?(): Promise<RuntimeTrainingGraderContribution>;
  credentials?: Readonly<Record<string, () => Promise<TrainingCredentialOperations>>>;
}
