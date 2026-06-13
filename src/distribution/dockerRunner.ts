import { spawn } from "node:child_process";

import { SpawnfileError } from "../shared/index.js";

export interface DockerCommandRunner {
  /** Runs docker with args; resolves stdout as a Buffer. Rejects on non-zero exit. */
  (args: string[]): Promise<Buffer>;
}

export const createConsumerDockerRunner = (
  dockerCommand: string,
  baseArgs: string[]
): DockerCommandRunner =>
  async (args: string[]): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      const finalArgs = [...baseArgs, ...args];
      const child = spawn(dockerCommand, finalArgs, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: string[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
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
