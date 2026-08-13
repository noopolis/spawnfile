import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

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

/** `docker cp <containerRef>:<containerPath> <hostPath>` — best-effort, returns false
 * instead of throwing (a single missing file inside an otherwise-live container is a
 * per-file concern, handled by the caller via each planned file's `optional` flag). */
export const copyContainerFileToHost = async (input: {
  containerPath: string;
  containerRef: string;
  hostPath: string;
  target: DeploymentRecord["target"];
} & DockerRunnerOptions): Promise<boolean> => {
  try {
    await input.execFile(
      input.dockerCommand,
      withDockerTarget(input.target, ["cp", `${input.containerRef}:${input.containerPath}`, input.hostPath]),
      { timeout: input.timeoutMs }
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * Reads one file out of a named Docker volume without needing the volume's original
 * container: creates a throwaway container (never started — its own entrypoint never
 * runs) with the volume read-only mounted, `docker cp`s the single file out, then always
 * removes the throwaway container. `readerImage` is expected to be an image already
 * present locally (the deployment's own `unit.image_tag` is the natural choice — it is
 * guaranteed to exist wherever the deployment itself ran, so this never needs to pull a
 * new "tiny image" from a registry).
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
  } catch {
    return false;
  }

  try {
    await input.execFile(
      input.dockerCommand,
      withDockerTarget(input.target, ["cp", `${readerContainerName}:${mountPoint}/${input.volumePath}`, input.hostPath]),
      { timeout: input.timeoutMs }
    );
    return true;
  } catch {
    return false;
  } finally {
    await input.execFile(
      input.dockerCommand,
      withDockerTarget(input.target, ["rm", "-f", readerContainerName]),
      { timeout: input.timeoutMs }
    ).catch(() => undefined);
  }
};

export const defaultDockerArtifactExecFile: DockerArtifactExecFile = execFile;
