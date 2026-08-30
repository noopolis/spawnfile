import { SpawnfileError } from "../shared/index.js";
import type { DockerTargetExecFile } from "../target/dockerTarget.js";

import { parseContext, runtimeFailure } from "./targetConfigResolverValidation.js";

const MAX_DOCKER_OUTPUT_BYTES = 64 * 1_024;

export const exactJson = (
  source: string,
  keys: readonly string[],
  failureMessage: string,
): Record<string, unknown> => {
  if (Buffer.byteLength(source, "utf8") > MAX_DOCKER_OUTPUT_BYTES) {
    return runtimeFailure(failureMessage);
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join("\0") !== [...keys].sort().join("\0")) {
      return runtimeFailure(failureMessage);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return runtimeFailure(failureMessage);
  }
};

export const executeDocker = async (
  execFile: DockerTargetExecFile,
  command: string,
  context: string,
  args: string[],
  timeout: number,
  signal: AbortSignal | undefined,
  failureMessage: string,
): Promise<string> => {
  try {
    const result = await execFile(command, ["--context", context, ...args], { signal, timeout });
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_DOCKER_OUTPUT_BYTES) {
      return runtimeFailure(failureMessage);
    }
    return result.stdout;
  } catch {
    return runtimeFailure(failureMessage);
  }
};

export const resolveCurrentDockerContext = async (
  execFile: DockerTargetExecFile,
  dockerCommand: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> => {
  try {
    const result = await execFile(dockerCommand, ["context", "show"], {
      signal, timeout: timeoutMs,
    });
    if (Buffer.byteLength(result.stdout, "utf8") > 4_096) {
      return runtimeFailure("Current Docker context is invalid");
    }
    return parseContext(result.stdout.trim());
  } catch (error) {
    if (error instanceof SpawnfileError) throw error;
    return runtimeFailure("Unable to resolve the current Docker context");
  }
};
