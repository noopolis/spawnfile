import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { DeploymentRecord } from "./record.js";
import { dockerContextNameForTarget } from "./target.js";

const execFile = promisify(execFileCallback);

/** Same injectable exec shape as `artifactsExportDocker.ts`/`dockerInspect.ts` — real
 * Docker calls are the default, tests inject a fake. */
export type DockerTeardownExecFile = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stderr: string; stdout: string }>;

export interface DockerTeardownRunnerOptions {
  dockerCommand: string;
  execFile: DockerTeardownExecFile;
  timeoutMs: number;
}

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

export interface DockerRemovalOutcome {
  error: string | null;
  removed: boolean;
}

/**
 * `docker rm -f <containerRef>` — force-removes a container whether it is running or
 * already stopped. A container Docker reports as already gone ("No such container")
 * counts as removed: `spawnfile down` is idempotent (calling it twice, or after the
 * container died on its own, is a success, not a partial failure).
 */
export const removeDockerContainer = async (
  target: DeploymentRecord["target"],
  containerRef: string,
  options: DockerTeardownRunnerOptions
): Promise<DockerRemovalOutcome> => {
  try {
    await options.execFile(
      options.dockerCommand,
      withDockerTarget(target, ["rm", "-f", containerRef]),
      { timeout: options.timeoutMs }
    );
    return { error: null, removed: true };
  } catch (error) {
    const message = toErrorMessage(error);
    if (/No such container/i.test(message)) {
      return { error: null, removed: true };
    }
    return { error: message, removed: false };
  }
};

/**
 * `docker volume rm -f <volumeName>` — only called when the caller explicitly opts into
 * volume removal (`spawnfile down --volumes`; the default is to retain volumes). A volume
 * Docker reports as already gone ("No such volume") also counts as removed.
 */
export const removeDockerVolume = async (
  target: DeploymentRecord["target"],
  volumeName: string,
  options: DockerTeardownRunnerOptions
): Promise<DockerRemovalOutcome> => {
  try {
    await options.execFile(
      options.dockerCommand,
      withDockerTarget(target, ["volume", "rm", "-f", volumeName]),
      { timeout: options.timeoutMs }
    );
    return { error: null, removed: true };
  } catch (error) {
    const message = toErrorMessage(error);
    if (/No such volume/i.test(message)) {
      return { error: null, removed: true };
    }
    return { error: message, removed: false };
  }
};

export const defaultDockerTeardownExecFile: DockerTeardownExecFile = execFile;
