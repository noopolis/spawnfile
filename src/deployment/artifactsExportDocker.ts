import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

import type { DeploymentRecord } from "./record.js";
import { dockerContextNameForTarget } from "./target.js";

const execFile = promisify(execFileCallback);

/** Same injectable exec shape as `dockerInspect.ts`/`dockerLogs.ts` — real Docker calls
 * are the default, tests inject a fake. */
export type DockerArtifactExecFile = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stderr: string; stdout: string }>;

const withDockerTarget = (target: DeploymentRecord["target"], args: string[]): string[] => {
  const context = dockerContextNameForTarget(target);
  if (context) {
    return ["--context", context, ...args];
  }
  if (target.kind === "host") {
    return ["--host", target.value, ...args];
  }
  return args;
};

const toErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.length > 0) {
      return stderr.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
};

export interface DockerRunnerOptions {
  dockerCommand: string;
  execFile: DockerArtifactExecFile;
  timeoutMs: number;
}

/**
 * True when `containerRef` (an id or name) still exists in Docker, false when Docker
 * reports it missing (a stopped-and-removed container, or one never created). Any other
 * Docker failure (daemon unreachable, context misconfigured, ...) is re-thrown rather than
 * folded into "missing" — export-before-teardown detection must not misreport a genuine
 * Docker connectivity problem as "this deployment was already torn down".
 */
export const containerExists = async (
  target: DeploymentRecord["target"],
  containerRef: string,
  options: DockerRunnerOptions
): Promise<boolean> => {
  try {
    await options.execFile(
      options.dockerCommand,
      withDockerTarget(target, ["inspect", "--type", "container", containerRef]),
      { timeout: options.timeoutMs }
    );
    return true;
  } catch (error) {
    const message = toErrorMessage(error);
    if (/No such (?:object|container)/i.test(message)) {
      return false;
    }
    throw new Error(`Unable to check whether container "${containerRef}" exists: ${message}`);
  }
};

/** True when execFile reports the command was interrupted (timeout kill or signal). An
 * interrupted command's partial stderr never proves anything about the source. */
const wasInterrupted = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const fields = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return fields.killed === true
    || (typeof fields.signal === "string" && fields.signal.length > 0)
    || fields.code === "ETIMEDOUT";
};

/** Matches only the Docker diagnostics that name THIS exact source as absent:
 * `No such container:path: <ref>:<path>` (current CLI, from the source stat) and
 * `Could not find the file <path> in container <ref>` (older daemons). Anything else
 * (daemon unreachable, host write failure, permission, unrelated path) does not match. */
const reportsAbsentSource = (message: string, containerRef: string, containerPath: string): boolean =>
  message.includes(`No such container:path: ${containerRef}:${containerPath}`)
  || message.includes(`Could not find the file ${containerPath} in container ${containerRef}`);

/**
 * `docker cp <containerRef>:<sourcePath> <hostPath>`. Resolves true on success and false
 * ONLY when Docker named this exact source as absent AND a follow-up inspect confirms the
 * container itself is still available (the CLI reports a missing container with the same
 * `No such container:path` text, so the diagnostic alone is not proof). Every other
 * outcome (daemon, context, timeout, local disk or permission failure, missing container,
 * failed confirmation) throws, so the caller aborts instead of recording an optional miss.
 */
const copyOrConfirmAbsent = async (input: {
  containerRef: string;
  hostPath: string;
  sourcePath: string;
  target: DeploymentRecord["target"];
} & DockerRunnerOptions): Promise<boolean> => {
  const source = `${input.containerRef}:${input.sourcePath}`;
  try {
    await input.execFile(
      input.dockerCommand,
      withDockerTarget(input.target, ["cp", source, input.hostPath]),
      { timeout: input.timeoutMs }
    );
    return true;
  } catch (error) {
    const message = toErrorMessage(error);
    if (wasInterrupted(error) || !reportsAbsentSource(message, input.containerRef, input.sourcePath)) {
      throw new SpawnfileError("runtime_error", `Unable to copy "${source}" to "${input.hostPath}": ${message}`);
    }
  }
  let available: boolean;
  try {
    available = await containerExists(input.target, input.containerRef, input);
  } catch (error) {
    throw new SpawnfileError(
      "runtime_error",
      `Unable to confirm "${source}" is absent: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!available) {
    throw new SpawnfileError("runtime_error", `Unable to copy "${source}": container "${input.containerRef}" is not available`);
  }
  return false;
};

/** Copies one container file to the host. Resolves false only for a confirmed absent
 * source inside an available container (a per-file concern the caller resolves through
 * each planned file's `optional` flag); every other Docker or host failure throws. */
export const copyContainerFileToHost = async (input: {
  containerPath: string;
  containerRef: string;
  hostPath: string;
  target: DeploymentRecord["target"];
} & DockerRunnerOptions): Promise<boolean> =>
  copyOrConfirmAbsent({ ...input, sourcePath: input.containerPath });

/**
 * Reads one file out of a named Docker volume without needing the volume's original
 * container: creates a throwaway container (never started, so its own entrypoint never
 * runs) with the volume read-only mounted, `docker cp`s the single file out, then always
 * removes the throwaway container. `readerImage` is expected to be an image already
 * present locally (the deployment's own `unit.image_tag` is the natural choice: it is
 * guaranteed to exist wherever the deployment itself ran, so this never needs to pull a
 * new "tiny image" from a registry).
 *
 * A reader `create` failure (missing reader image, volume create/mount failure, daemon,
 * timeout) throws: no reader means nothing is known about the source. Resolves false only
 * when the reader exists and Docker confirms the file is absent from the mounted volume.
 */
export const copyVolumeFileToHost = async (input: {
  hostPath: string;
  readerImage: string;
  target: DeploymentRecord["target"];
  volumeName: string;
  volumePath: string;
} & DockerRunnerOptions): Promise<boolean> => {
  const mountPoint = "/spawnfile-export-src";
  const readerContainerName = `spawnfile-artifacts-export-${randomUUID()}`;

  try {
    await input.execFile(
      input.dockerCommand,
      withDockerTarget(input.target, [
        "create",
        "--name", readerContainerName,
        "-v", `${input.volumeName}:${mountPoint}:ro`,
        input.readerImage
      ]),
      { timeout: input.timeoutMs }
    );
  } catch (error) {
    // A timed-out create may still have created the reader; removal is best effort.
    await input.execFile(
      input.dockerCommand,
      withDockerTarget(input.target, ["rm", "-f", readerContainerName]),
      { timeout: input.timeoutMs }
    ).catch(() => undefined);
    throw new SpawnfileError(
      "runtime_error",
      `Unable to create a reader for volume "${input.volumeName}" from image "${input.readerImage}": ${toErrorMessage(error)}`
    );
  }

  try {
    return await copyOrConfirmAbsent({
      containerRef: readerContainerName,
      dockerCommand: input.dockerCommand,
      execFile: input.execFile,
      hostPath: input.hostPath,
      sourcePath: `${mountPoint}/${input.volumePath}`,
      target: input.target,
      timeoutMs: input.timeoutMs
    });
  } finally {
    await input.execFile(
      input.dockerCommand,
      withDockerTarget(input.target, ["rm", "-f", readerContainerName]),
      { timeout: input.timeoutMs }
    ).catch(() => undefined);
  }
};

export const defaultDockerArtifactExecFile: DockerArtifactExecFile = execFile;
