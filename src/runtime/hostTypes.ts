import type { ResolvedAuthProfile } from "../auth/index.js";
import type { BackedMountRequirement } from "../compiler/containerBackedMountRender.js";
import type { RuntimeTargetPlan } from "../compiler/containerArtifactsTypes.js";
import type { EntrypointOptions } from "../compiler/containerEntrypointRender.js";
import type { CompileProjectResult } from "../compiler/compileProject.js";
import type { DockerRunInvocation } from "../compiler/runProjectDocker.js";
import type { DockerCommandRunner } from "../distribution/dockerRunner.js";
import type { DistributionRuntimeInstance } from "../distribution/types.js";
import type { ModelAuthMethod } from "../shared/types.js";
import type { ContainerLocalRuntimeIdentity } from "../report/types.js";
import type { EmittedFile } from "./types.js";

export interface RuntimeHostBuildInput {
  runtimePlans: RuntimeTargetPlan[];
  persistentMountPaths: string[];
  persistentMounts: readonly BackedMountRequirement[];
  moltnet?: EntrypointOptions["moltnet"];
}

export interface RuntimeHostEntrypoint {
  /** The wrapper runs before the shared entrypoint and owns the UID boundary. */
  path: string;
  accountUid: number;
  prelude: readonly string[];
  rootfsFiles(input: RuntimeHostBuildInput): EmittedFile[];
  afterRootfsCopy?: readonly string[];
  afterEntrypointChmod?: string;
  finalizeInstall?(plans: readonly RuntimeTargetPlan[]): string[];
  healthcheck?(plan: RuntimeTargetPlan): string;
  stateOwnership?(input: RuntimeHostBuildInput): string[];
}

export interface RuntimeHostSecret {
  bytes: number;
  encoding: "hex" | "base64url";
  generateForImage?: boolean;
}

export interface RuntimeImageMountInput {
  authProfile: ResolvedAuthProfile | null;
  containerCredentialUid?: number;
  sourceEnvironment: Record<string, string | undefined>;
  tempRoot: string;
}

export type RuntimeImageAuthPreparer = (
  instance: DistributionRuntimeInstance, input: RuntimeImageMountInput
) => Promise<string[]>;

export interface RuntimeImageLaunchInput {
  imageRef: string;
  instances: readonly DistributionRuntimeInstance[];
  runDocker: DockerCommandRunner;
  securityDirectory: string;
}

export interface RuntimePreparedImageLaunch {
  securityArgs: string[];
  prepareAuth?: RuntimeImageAuthPreparer;
}

export interface RuntimeHostIntegration {
  /** The runtime owns model credentials and emits no generic model-auth facts. */
  ownsModelCredentials?: boolean;
  handlesImageModelAuth?(method: ModelAuthMethod): boolean;
  includeEmptyTargets?: boolean;
  entrypoint?: RuntimeHostEntrypoint;
  environmentPrelude?: readonly string[];
  prebuiltSystemDeps?: readonly string[];
  generatedSecrets?: Readonly<Record<string, RuntimeHostSecret>>;
  externalMountEnvironment?(mountId: string): string | undefined;
  profileVolumeName?(mountId: string, profile: ResolvedAuthProfile | null): string | undefined;
  projectSecurityArgs?(compiled: CompileProjectResult): Promise<string[]>;
  prepareCredentialDocker?(invocation: DockerRunInvocation): Promise<DockerRunInvocation>;
  prepareImageLaunch?(input: RuntimeImageLaunchInput): Promise<RuntimePreparedImageLaunch>;
  prepareImageAuth?: RuntimeImageAuthPreparer;
  /** Compatibility output for the existing host-local image receipt. */
  localImageReport?(): Promise<ContainerLocalRuntimeIdentity | undefined>;
}
