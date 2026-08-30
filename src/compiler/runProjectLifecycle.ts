import { rm } from "node:fs/promises";

import { removeDirectory } from "../filesystem/index.js";

import type {
  DockerRunInvocation,
  DockerRunResult,
  DockerRunRunner
} from "./runProjectDocker.js";

/**
 * Docker consumes an env file before a detached container is started, so the
 * generated copy must not become a durable credential store. Other files in
 * the support directory may be active bind-mount sources and must remain.
 */
export const executeDockerRunWithSupportCleanup = async (
  invocation: DockerRunInvocation,
  runner: DockerRunRunner
): Promise<DockerRunResult | void> => {
  let started = false;
  try {
    const runInvocation: DockerRunInvocation = invocation.detach
      ? {
          ...invocation,
          onDetachedStarted: async (result) => {
            await invocation.onDetachedStarted?.(result);
            started = true;
            await rm(invocation.envFilePath, { force: true });
          }
        }
      : invocation;
    const result = await runner(runInvocation);
    if (invocation.detach) {
      if (!started) {
        started = true;
        await rm(invocation.envFilePath, { force: true });
      }
    } else {
      started = true;
      await removeDirectory(invocation.supportDirectory);
    }
    return result;
  } catch (error) {
    if (!started) {
      await removeDirectory(invocation.supportDirectory);
    }
    throw error;
  }
};
