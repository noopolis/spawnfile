import { SpawnfileError } from "../shared/index.js";
import { parseOpaqueTargetHandle, parseRunId, type OpaqueTargetHandle } from "./contracts.js";
import {
  DOCKER_SECRET_ERROR,
  DockerSecretProviderError,
  createExistingDockerSecretSpec,
  executeDockerSecretCommand,
  isExpectedDockerSecretVolume,
  parseExpectedDockerSecretWriter,
  type DockerSecretExecutor,
  type DockerSecretSpec,
  type DockerSecretWriterState
} from "./dockerSecretsProvider.js";

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const fail = (): never => { throw new SpawnfileError("runtime_error", DOCKER_SECRET_ERROR); };

export interface DockerSecretLifecycleOptions {
  readonly context: string;
  readonly executor: DockerSecretExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface DockerSecretCleanupAuthority {
  readonly bindingsHandle: OpaqueTargetHandle;
  readonly runId: string;
  readonly selectedTargetHandle: OpaqueTargetHandle;
}

const exactOrdinary = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(raw);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return false;
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
};

const parseAuthority = (raw: unknown): DockerSecretCleanupAuthority => {
  if (!exactOrdinary(raw, ["bindingsHandle", "runId", "selectedTargetHandle"])) return fail();
  return {
    bindingsHandle: parseOpaqueTargetHandle(raw.bindingsHandle),
    runId: parseRunId(raw.runId),
    selectedTargetHandle: parseOpaqueTargetHandle(raw.selectedTargetHandle)
  };
};

export const validateDockerSecretLifecycleOptions = (
  raw: DockerSecretLifecycleOptions
): DockerSecretLifecycleOptions => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || typeof raw.context !== "string" || !CONTEXT_PATTERN.test(raw.context)
    || typeof raw.executor !== "function" || !Number.isSafeInteger(raw.timeoutMs)
    || raw.timeoutMs < 1 || raw.timeoutMs > 120_000
    || raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) return fail();
  return raw;
};

export const executeSecretLifecycleCommand = (
  args: string[],
  options: DockerSecretLifecycleOptions,
  input?: { readonly requireSilent?: boolean; readonly stdin?: Uint8Array }
): Promise<{ stderr: string; stdout: string }> => executeDockerSecretCommand({
  args,
  executor: options.executor,
  requireSilent: input?.requireSilent,
  signal: options.signal,
  stdin: input?.stdin,
  timeoutMs: options.timeoutMs
});

export const inspectExactSecretVolume = async (
  spec: DockerSecretSpec,
  options: DockerSecretLifecycleOptions
): Promise<"absent" | "present"> => {
  try {
    const result = await executeSecretLifecycleCommand([
      "--context", options.context, "volume", "inspect", "--format",
      spec.volumeInspectionFormat, spec.volumeName
    ], options);
    if (result.stderr !== "" || !isExpectedDockerSecretVolume(result.stdout, spec)) return fail();
    return "present";
  } catch (error) {
    if (error instanceof DockerSecretProviderError && error.kind === "not_found") return "absent";
    throw error;
  }
};

export const inspectExactSecretWriter = async (
  spec: DockerSecretSpec,
  options: DockerSecretLifecycleOptions
): Promise<"absent" | DockerSecretWriterState> => {
  try {
    const result = await executeSecretLifecycleCommand([
      "--context", options.context, "container", "inspect", "--format",
      spec.writerInspectionFormat, spec.writerName
    ], options);
    const state = parseExpectedDockerSecretWriter(result.stdout, spec);
    if (result.stderr !== "" || state === null) return fail();
    return state;
  } catch (error) {
    if (error instanceof DockerSecretProviderError && error.kind === "not_found") return "absent";
    throw error;
  }
};

const acknowledged = (
  result: { readonly stderr: string; readonly stdout: string },
  name: string
): void => {
  if (result.stderr !== "" || result.stdout !== `${name}\n`) fail();
};

const mutateAndReconcile = async (
  args: string[],
  name: string,
  proveAbsent: () => Promise<boolean>,
  options: DockerSecretLifecycleOptions
): Promise<void> => {
  let result: { readonly stderr: string; readonly stdout: string } | undefined;
  let error: unknown;
  try { result = await executeSecretLifecycleCommand(args, options); } catch (caught) { error = caught; }
  if (result) acknowledged(result, name);
  if (!await proveAbsent()) {
    if (error) throw error;
    fail();
  }
};

/** Journal-free exact cleanup for one already-authorized secret binding. */
export const cleanupExactDockerSecretBindings = async (
  rawAuthority: unknown,
  rawOptions: DockerSecretLifecycleOptions
): Promise<void> => {
  try {
    // Parse every caller-controlled value before the first provider call.
    const authority = parseAuthority(rawAuthority);
    const options = validateDockerSecretLifecycleOptions(rawOptions);
    const spec = createExistingDockerSecretSpec(authority);

    const writer = await inspectExactSecretWriter(spec, options);
    const initialVolume = await inspectExactSecretVolume(spec, options);
    if (writer !== "absent") {
      if (writer.status === "running" || writer.status === "paused" || writer.status === "restarting") {
        await mutateAndReconcile(
          [
            "--context", options.context, "container", "stop",
            "--timeout", "10", spec.writerName
          ],
          spec.writerName,
          async () => {
            const state = await inspectExactSecretWriter(spec, options);
            return state === "absent" || !["running", "paused", "restarting"].includes(state.status);
          },
          options
        );
      } else if (writer.status === "removing") return fail();

      if (await inspectExactSecretWriter(spec, options) !== "absent") {
        await mutateAndReconcile(
          ["--context", options.context, "container", "rm", spec.writerName],
          spec.writerName,
          async () => await inspectExactSecretWriter(spec, options) === "absent",
          options
        );
      }
    }

    const volumeBeforeRemoval = writer === "absent"
      ? initialVolume
      : await inspectExactSecretVolume(spec, options);
    if (volumeBeforeRemoval === "absent") return;
    await mutateAndReconcile(
      ["--context", options.context, "volume", "rm", spec.volumeName],
      spec.volumeName,
      async () => await inspectExactSecretVolume(spec, options) === "absent",
      options
    );
  } catch { return fail(); }
};
