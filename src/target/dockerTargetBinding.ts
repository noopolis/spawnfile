import { createHash } from "node:crypto";

import { SpawnfileError } from "../shared/index.js";
import { SELECTED_TARGET_VERSION, parseOpaqueTargetHandle, parseSelectedTargetReceipt, type SelectedTargetReceipt } from "./contracts.js";
import { createEndpointFingerprint } from "./dockerEndpointFingerprint.js";
import type { DockerTargetExecFile, ResolveDockerDeploymentTargetOptions, SelectTargetOptions } from "./dockerTarget.js";
import { defaultDockerTargetExecFile } from "./dockerTargetExecFile.js";

export { defaultDockerTargetExecFile } from "./dockerTargetExecFile.js";
const TARGET_SELECTION_ERROR = "Target selection failed";
const DOCKER_CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_RAW_EXECUTOR_STDOUT_BYTES = 4_096;

/** Private owner-only endpoint binding. Never export this module through the target barrel. */
export interface ResolvedSelectedTargetBinding {
  readonly endpoint: string;
  readonly selected: SelectedTargetReceipt;
}

const parseDockerEndpoint = (stdout: string): string => {
  if (Buffer.byteLength(stdout, "utf8") > MAX_RAW_EXECUTOR_STDOUT_BYTES) {
    throw new SpawnfileError("runtime_error", TARGET_SELECTION_ERROR);
  }
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new SpawnfileError("runtime_error", "Docker context endpoint was empty");
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string" && parsed.trim().length > 0) return parsed.trim();
  } catch {
    // Docker/podman variants may return a plain string instead of JSON.
  }
  return trimmed;
};

export const resolveDockerContextEndpoint = async (
  context: string,
  options: Required<Pick<ResolveDockerDeploymentTargetOptions, "dockerCommand" | "execFile" | "timeoutMs">>
    & Pick<ResolveDockerDeploymentTargetOptions, "signal">
): Promise<string> => {
  try {
    const { stdout } = await options.execFile(
      options.dockerCommand,
      ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"],
      { signal: options.signal, timeout: options.timeoutMs }
    );
    return parseDockerEndpoint(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError("runtime_error", `Unable to resolve Docker context "${context}": ${reason}`);
  }
};

const selectionFailure = (code: "runtime_error" | "validation_error"): never => {
  throw new SpawnfileError(code, TARGET_SELECTION_ERROR);
};

const selectTargetContext = (input: SelectTargetOptions): string => {
  if (input.DOCKER_HOST != null || input.dockerHost != null || input.endpoint != null || input.host != null) {
    return selectionFailure("validation_error");
  }
  if (typeof input.context !== "string" || !DOCKER_CONTEXT_PATTERN.test(input.context)) {
    return selectionFailure("validation_error");
  }
  return input.context;
};

const isDockerContextEndpoint = (endpoint: string): boolean =>
  endpoint.length <= 4_096
  && /^(?:npipe|ssh|tcp|unix|fd|http|https):\/\/[^\s]+$/u.test(endpoint);

const selectTargetOptions = (input: SelectTargetOptions): Required<Pick<ResolveDockerDeploymentTargetOptions, "dockerCommand" | "execFile" | "timeoutMs">>
  & Pick<ResolveDockerDeploymentTargetOptions, "signal"> => {
  if (input.dockerCommand !== undefined && (typeof input.dockerCommand !== "string" || input.dockerCommand.length === 0 || input.dockerCommand.length > 128)) {
    return selectionFailure("validation_error");
  }
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)) {
    return selectionFailure("validation_error");
  }
  return {
    dockerCommand: input.dockerCommand ?? "docker",
    execFile: input.execFile ?? defaultDockerTargetExecFile,
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? 10_000
  };
};

const createSelectedTargetHandle = (context: string, fingerprint: string) => parseOpaqueTargetHandle(
  `opaque_${createHash("sha256")
    .update("spawnfile.target-resource.selected-target.v1\0", "utf8")
    .update(context, "utf8")
    .update("\0", "utf8")
    .update(fingerprint, "utf8")
    .digest("hex")}`
);

export const selectedTargetForContextEndpoint = (
  context: string,
  endpoint: string
): SelectedTargetReceipt => {
  if (!DOCKER_CONTEXT_PATTERN.test(context) || !isDockerContextEndpoint(endpoint)) {
    return selectionFailure("runtime_error");
  }
  const fingerprint = createEndpointFingerprint(endpoint);
  return parseSelectedTargetReceipt({
    fingerprint,
    handle: createSelectedTargetHandle(context, fingerprint),
    version: SELECTED_TARGET_VERSION
  });
};

export const resolveSelectedTargetBinding = async (
  input: SelectTargetOptions = {}
): Promise<ResolvedSelectedTargetBinding> => {
  try {
    const context = selectTargetContext(input);
    const endpoint = await resolveDockerContextEndpoint(context, selectTargetOptions(input));
    const selected = selectedTargetForContextEndpoint(context, endpoint);
    return Object.freeze({ endpoint, selected });
  } catch {
    return selectionFailure("runtime_error");
  }
};

/** Resolves one explicit named Docker context without exposing private selector data. */
export const selectTarget = async (input: SelectTargetOptions = {}): Promise<SelectedTargetReceipt> =>
  (await resolveSelectedTargetBinding(input)).selected;
