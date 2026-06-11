import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

export interface DockerRunInvocation {
  args: string[];
  command: string;
  containerName: string | null;
  cwd: string;
  detach: boolean;
  deploymentName?: string | null;
  dockerContext?: string | null;
  dockerHost?: string | null;
  envFilePath: string;
  imageTag: string;
  supportDirectory: string;
}

export interface DockerRunResult {
  containerId?: string;
  imageId?: string;
}

export type DockerRunRunner = (invocation: DockerRunInvocation) => Promise<DockerRunResult | void>;

const inspectImageArgs = (
  invocation: DockerRunInvocation,
  containerId: string
): string[] => {
  const base = invocation.dockerContext
    ? ["--context", invocation.dockerContext, "inspect"]
    : invocation.dockerHost
      ? ["--host", invocation.dockerHost, "inspect"]
      : ["inspect"];
  return [...base, "--format", "{{.Image}}", containerId];
};

const inspectDetachedImageId = async (
  invocation: DockerRunInvocation,
  containerId: string
): Promise<string | undefined> => {
  try {
    const { stdout } = await execFile(invocation.command, inspectImageArgs(invocation, containerId), {
      cwd: invocation.cwd,
      timeout: 10_000
    });
    return stdout.trim() || undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "runtime_error",
      `Unable to inspect detached container ${containerId} image id: ${message}`
    );
  }
};

export const runDockerContainer: DockerRunRunner = async (
  invocation: DockerRunInvocation
): Promise<DockerRunResult | void> =>
  new Promise<DockerRunResult | void>((resolve, reject) => {
    let stdout = "";
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: invocation.detach ? ["ignore", "pipe", "inherit"] : "inherit"
    });

    if (invocation.detach && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    child.once("error", (error) => {
      reject(
        new SpawnfileError(
          "runtime_error",
          `Unable to start docker run for ${invocation.imageTag}: ${error.message}`
        )
      );
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        const containerId = stdout.trim().split(/\s+/)[0];
        if (!invocation.detach || !containerId) {
          resolve(undefined);
          return;
        }
        inspectDetachedImageId(invocation, containerId)
          .then((imageId) => resolve({ containerId, ...(imageId ? { imageId } : {}) }))
          .catch(reject);
        return;
      }

      reject(
        new SpawnfileError(
          "runtime_error",
          signal
            ? `Docker run for ${invocation.imageTag} exited from signal ${signal}`
            : `Docker run for ${invocation.imageTag} failed with exit code ${code ?? "unknown"}`
        )
      );
    });
  });
