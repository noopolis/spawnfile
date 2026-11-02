import { execFile } from "node:child_process";

import { SpawnfileError } from "../../../shared/index.js";

/** Bounded Docker CLI call for trial lifecycle; stdout trimmed, stderr bounded into the error. */
/** `combined` returns stderr after stdout (container logs write both). */
export type TrialDocker = (args: readonly string[], options?: { timeoutMs?: number; stdin?: string; combined?: boolean }) => Promise<string>;

export const createTrialDocker = (dockerCommand = "docker"): TrialDocker => (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(dockerCommand, [...args], { maxBuffer: 16 * 1024 * 1024, timeout: options.timeoutMs ?? 120_000 },
      (error, stdout, stderr) => error
        ? reject(new SpawnfileError("runtime_error", `docker ${args[0]} ${args[1] ?? ""} failed: ${String(stderr).replace(/\s+/gu, " ").slice(-400)}`))
        : resolve(`${stdout}${options.combined ? stderr : ""}`.trim()));
    if (options.stdin !== undefined) child.stdin?.end(options.stdin); else child.stdin?.end();
  });

/** Poll `probe` until it resolves true, or fail after `timeoutMs`. */
export const waitFor = async (probe: () => Promise<boolean>, timeoutMs: number, label: string, pollMs = 500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() >= deadline) throw new SpawnfileError("runtime_error", `${label} timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};
