import { spawn } from "node:child_process";

export interface TrainingDockerProcess {
  (args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal; stdout?: (line: string) => void; stderr?: (line: string) => void }): Promise<{ code: number; stdout: string; stderr: string }>;
}
/** Docker client only; no model executable runs on the host. */
export const runTrainingDocker: TrainingDockerProcess = (args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(Error("Training Docker operation cancelled")); return; }
  const child = spawn("docker", [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", failure: Error | undefined;
  let forceClose: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const pending = { stdout: "", stderr: "" };
  const stop = (message: string): void => {
    failure ??= Error(message); child.kill("SIGKILL");
    forceClose ??= setTimeout(() => {
      // Releasing a stuck client lets the owner independently stop/verify the container.
      child.stdout.destroy(); child.stderr.destroy(); finish(null);
    }, 1000);
  };
  const abort = (): void => stop("Training Docker operation cancelled");
  const timer = setTimeout(() => stop("Training Docker operation exceeded deadline"), options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const consume = (channel: "stdout" | "stderr", chunk: string): void => {
    pending[channel] += chunk;
    if (Buffer.byteLength(pending[channel]) > 1024 * 1024) { stop("Docker output exceeded bounded line size"); return; }
    const lines = pending[channel].split("\n"); pending[channel] = lines.pop()!;
    for (const line of lines) {
      options[channel]?.(line);
      if (channel === "stdout") stdout = options.stdout ? line : stdout + line + "\n";
      else stderr = options.stderr ? line : stderr + line + "\n";
      if (stdout.length + stderr.length > 2 * 1024 * 1024) stop("Docker output exceeded bounded capture size");
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => consume("stdout", chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => consume("stderr", chunk));
  child.once("error", (error) => { failure = error; });
  const finish = (code: number | null): void => {
    if (settled) return; settled = true;
    clearTimeout(forceClose); clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    for (const channel of ["stdout", "stderr"] as const) if (pending[channel]) {
      options[channel]?.(pending[channel]);
      if (channel === "stdout") stdout = options.stdout ? pending[channel] : stdout + pending[channel];
      else stderr = options.stderr ? pending[channel] : stderr + pending[channel];
    }
    if (failure) reject(failure); else resolve({ code: code ?? 1, stdout, stderr });
  };
  child.once("close", finish);
});
