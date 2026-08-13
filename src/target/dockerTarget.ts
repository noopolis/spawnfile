import { createEndpointFingerprint } from "./dockerEndpointFingerprint.js";
import { SpawnfileError } from "../shared/index.js";
import { defaultDockerTargetExecFile, resolveDockerContextEndpoint, selectTarget as selectTargetInternal } from "./dockerTargetBinding.js";


export type DockerDeploymentTarget =
  | { endpoint_fingerprint: string; kind: "context"; name: string }
  | { endpoint_fingerprint: string; kind: "docker-context"; context: string }
  | { kind: "host"; value: string };

export type DockerTargetExecFile = (
  file: string,
  args: string[],
  options: { signal?: AbortSignal; timeout: number }
) => Promise<{ stderr: string; stdout: string }>;

export interface ResolveDockerDeploymentTargetOptions {
  context?: string | null;
  dockerCommand?: string;
  dockerHost?: string | null;
  execFile?: DockerTargetExecFile;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Inputs for the named-context-only target-resource selection operation. */
export interface SelectTargetOptions {
  DOCKER_HOST?: unknown;
  context?: unknown;
  dockerCommand?: unknown;
  dockerHost?: unknown;
  endpoint?: unknown;
  execFile?: DockerTargetExecFile;
  host?: unknown;
  signal?: AbortSignal;
  timeoutMs?: unknown;
}

export { createEndpointFingerprint } from "./dockerEndpointFingerprint.js";

export const createDockerDeploymentTarget = (input: { context?: string; endpoint?: string; host?: string }): DockerDeploymentTarget => {
  const host = input.host?.trim();
  if (host) return { kind: "host", value: host };
  const context = input.context?.trim();
  const endpoint = input.endpoint?.trim();
  if (!context || !endpoint) {
    throw new SpawnfileError("validation_error", "Docker context deployment targets require both context and endpoint");
  }
  return { name: context, endpoint_fingerprint: createEndpointFingerprint(endpoint), kind: "context" };
};

export const dockerContextNameForTarget = (target: DockerDeploymentTarget): string | null =>
  target.kind === "context" ? target.name : target.kind === "docker-context" ? target.context : null;

export const dockerHostValueForTarget = (target: DockerDeploymentTarget): string | null =>
  target.kind === "host" ? target.value : null;

export const resolveDockerDeploymentTarget = async (
  input: ResolveDockerDeploymentTargetOptions = {}
): Promise<DockerDeploymentTarget> => {
  const explicitContext = input.context?.trim();
  const host = explicitContext ? undefined : input.dockerHost?.trim() ?? process.env.DOCKER_HOST?.trim();
  if (host) return createDockerDeploymentTarget({ host });
  const resolvedOptions = {
    dockerCommand: input.dockerCommand ?? "docker",
    execFile: input.execFile ?? defaultDockerTargetExecFile,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 10_000
  };
  const context = explicitContext || "default";
  const endpoint = await resolveDockerContextEndpoint(context, resolvedOptions);
  return createDockerDeploymentTarget({ context, endpoint });
};

export const verifyDockerDeploymentTarget = async (
  target: DockerDeploymentTarget,
  options: Omit<ResolveDockerDeploymentTargetOptions, "context" | "dockerHost"> = {}
): Promise<string | null> => {
  if (target.kind === "host") return null;
  const context = dockerContextNameForTarget(target);
  if (!context) return null;
  const current = await resolveDockerDeploymentTarget({ ...options, context });
  const currentFingerprint = current.kind === "host" ? null : current.endpoint_fingerprint;
  if (currentFingerprint !== target.endpoint_fingerprint) {
    throw new SpawnfileError("runtime_error", `Docker context "${context}" endpoint changed since deployment`);
  }
  return context;
};

/** Resolves one explicit named Docker context without exposing private selector data. */
export const selectTarget = selectTargetInternal;

export const select_target = selectTarget;
