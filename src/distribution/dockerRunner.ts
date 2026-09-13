import { spawn } from "node:child_process";

import { SpawnfileError } from "../shared/index.js";

export interface DockerCommandRunner {
  /** Runs docker with args; resolves stdout as a Buffer. Rejects on non-zero exit. */
  (args: string[], options?: DockerCommandOptions): Promise<Buffer>;
}

export interface DockerCommandOptions {
  captureStderr?: boolean;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export const createConsumerDockerRunner = (
  dockerCommand: string,
  baseArgs: string[]
): DockerCommandRunner =>
  async (args: string[], options: DockerCommandOptions = {}): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      const finalArgs = [...baseArgs, ...args];
      const child = spawn(dockerCommand, finalArgs, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: string[] = [];
      let bytes = 0;
      let stopped = false;
      const stop = (reason: string): void => {
        stopped = true;
        child.kill("SIGKILL");
        reject(new SpawnfileError("runtime_error", reason));
      };
      const timer = options.timeoutMs === undefined ? undefined
        : setTimeout(() => stop("Docker diagnostic command timed out"), options.timeoutMs);
      const clearTimer = (): void => { if (timer) clearTimeout(timer); };
      const collect = (chunk: Buffer, isStderr: boolean): void => {
        if (stopped) return;
        bytes += chunk.length;
        if (options.maxOutputBytes !== undefined && bytes > options.maxOutputBytes) {
          stop("Docker diagnostic output exceeded its byte limit");
          return;
        }
        if (isStderr) stderr.push(chunk.toString("utf8"));
        if (!isStderr || options.captureStderr) stdout.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, false));
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
      child.on("error", (error) => { clearTimer(); reject(error); });
      child.on("close", (code) => {
        clearTimer();
        if (stopped) return;
        if (code === 0) {
          resolve(Buffer.concat(stdout));
          return;
        }
        reject(
          new SpawnfileError(
            "runtime_error",
            `docker ${finalArgs[0]} failed (${code}): ${stderr.join("").trim()}`
          )
        );
      });
    });
