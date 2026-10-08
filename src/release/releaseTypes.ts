import type { ResolvedAuthProfile } from "../auth/index.js";
import type { CompileProjectResult } from "../compiler/compileProject.js";

import type { Availability, DrainWait, RuntimeControlTarget, WaitForDrainedOptions } from "./drainControl.js";
import type { NotifierConfig, NotifyResult, ReleaseNotification } from "./notify.js";
import type { PruneResult, RunningUnit, SettleOptions } from "./releaseDocker.js";

export const DAIMON_CONTROL_TOKEN_ENV = "SPAWNFILE_DAIMON_CONTROL_TOKEN";

export interface ReleaseRequest {
  authProfile?: ResolvedAuthProfile | null;
  authProfileName?: string | null;
  /** `release` (default) builds workspace bundles only from clean committed inputs. */
  bundleIdentity: "dev" | "release";
  deployment: string;
  dockerCommand: string;
  dockerContext?: string;
  /** False only when the operator explicitly accepts killing in-flight turns. */
  drain: boolean;
  drainPollMs: number;
  drainTimeoutMs: number;
  envFileEnv: Record<string, string>;
  envFilePath?: string;
  force: boolean;
  imageRepository?: string;
  inputPath: string;
  log: (line: string) => void;
  notifier: NotifierConfig;
  notifyDeferredAfterMs: number;
  now?: () => Date;
  outputDirectory?: string;
  /** Overrides `<SPAWNFILE_HOME>/releases`. */
  releaseRoot?: string;
  settle: SettleOptions;
  signal?: AbortSignal;
}

export interface CompiledRelease {
  compileMs: number;
  compileResult: CompileProjectResult;
  identity: string;
  repository: string;
}

export interface BuiltRelease {
  buildMs: number | null;
  imageId: string;
  imageTag: string;
  skipped: boolean;
}

export interface DeployedRelease {
  containerName: string;
  deployMs: number;
}

export interface PreparedInputs {
  authProfile: ResolvedAuthProfile | null;
  envFileEnv: Record<string, string>;
}

/**
 * Every effect a release has, injectable so the ORDER (drain before deploy,
 * resume on abort, never deploy on a drain timeout) is asserted by tests
 * rather than by a comment.
 */
export interface ReleaseDependencies {
  build(request: ReleaseRequest, compiled: CompiledRelease, imageTag: string): Promise<BuiltRelease>;
  compile(request: ReleaseRequest): Promise<CompiledRelease>;
  /** Deploys while the caller holds the deployment lock (see `lockDeployment`). */
  deploy(request: ReleaseRequest, imageTag: string): Promise<DeployedRelease>;
  inspectUnit(request: ReleaseRequest, containerRef: string): Promise<RunningUnit | null>;
  /** The same home lock `up` takes, held from the drain through the swap. */
  lockDeployment(deployment: string): Promise<() => Promise<void>>;
  notify(config: NotifierConfig, notification: ReleaseNotification): Promise<NotifyResult>;
  /** Reads the env file and auth profile inside the release, so their failures are reported like any other. */
  prepare(request: ReleaseRequest): Promise<PreparedInputs>;
  prune(request: ReleaseRequest, repository: string, keep: readonly (string | null)[]): Promise<PruneResult>;
  /** Runtime kinds inside the running image, from its embedded distribution report. */
  runtimesOf(request: ReleaseRequest, imageId: string): Promise<string[]>;
  requestDrain(target: RuntimeControlTarget): Promise<Availability>;
  requestResume(target: RuntimeControlTarget): Promise<Availability>;
  settle(request: ReleaseRequest, containerRef: string): Promise<RunningUnit>;
  waitForDrained(target: RuntimeControlTarget, options: WaitForDrainedOptions): Promise<DrainWait>;
}
