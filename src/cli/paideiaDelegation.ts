import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { trainingContextSchema, type TrainingContext } from "../compiler/training/index.js";
import { launchTrainingContainer } from "../compiler/training/container/index.js";
import { runTrainingDocker } from "../compiler/training/container/process.js";
import { prepareTraining } from "../compiler/training/preparation/index.js";
import { readBoundedJson } from "../compiler/training/preparation/inputs.js";
import { SpawnfileError } from "../shared/index.js";
import type { PaideiaProcessOutcome } from "./paideiaSupervisor.js";
import type { CliStreams } from "./runCli.js";

export interface DelegatePaideiaTrainingOptions {
  context: TrainingContext;
  command: string;
  args: readonly string[];
  dryRun: boolean;
  trainingImage?: string;
  trainingConfig?: string;
  timeoutMs: number;
  streams: CliStreams;
  signal?: AbortSignal;
}

const MAX_LINE_BYTES = 1024 * 1024;
const validReceipt = (line: string, dryRun: boolean): boolean => {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return false;
    const receipt = value as Record<string, unknown>;
    return dryRun
      ? receipt.schema === "paideia.training-cost-plan.v1" && receipt.modelCallsMade === 0
      : receipt.status === "completed" && typeof receipt.index === "string" && receipt.index.length > 0;
  } catch { return false; }
};
const failure = (message: string): SpawnfileError => new SpawnfileError("runtime_error", message);

const runChild = (options: DelegatePaideiaTrainingOptions, contextPath: string): Promise<number> => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { resolve(130); return; }
  // Node strips types in a source checkout; the packaged build selects its emitted JS.
  const extension = path.extname(fileURLToPath(import.meta.url));
  const supervisor = fileURLToPath(new URL(`./paideiaSupervisor${extension}`, import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", supervisor, options.command,
    "train", "--spawnfile-context", contextPath, ...options.args], {
    shell: false, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const pid = child.pid;
  let stdout = "", stderr = "", lastLine = "";
  let stopCode: number | undefined, error: Error | undefined, outcome: PaideiaProcessOutcome | undefined;
  let reaped = false, closed = false, finished = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals): void => {
    if (pid === undefined || reaped) return;
    try { process.kill(-pid, signal); }
    catch (caught) { if ((caught as NodeJS.ErrnoException).code !== "ESRCH") error = failure("Could not signal the owned Paideia process group"); }
  };
  const groupExists = (): boolean => {
    if (pid === undefined) return false;
    try { process.kill(-pid, 0); return true; }
    catch (caught) { return (caught as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  const stop = (code: number, cause?: Error): void => {
    if (stopCode !== undefined) return;
    stopCode = code; error = cause;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 1000);
    killTimer.unref();
  };
  const interrupt = (): void => stop(130), terminate = (): void => stop(143), abort = (): void => stop(130);
  const timer = setTimeout(() => stop(1, failure("Paideia training exceeded its command deadline")), options.timeoutMs);
  timer.unref();
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  const consume = (chunk: string, channel: "stdout" | "stderr"): void => {
    const lines = ((channel === "stdout" ? stdout : stderr) + chunk).split("\n");
    const remainder = lines.pop()!;
    if ([remainder, ...lines].some((line) => Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)) {
      stop(1, failure("Paideia output exceeded the bounded JSON-line contract")); return;
    }
    for (const raw of lines) {
      const line = raw.replace(/\r$/u, "");
      if (!line.trim()) continue;
      if (channel === "stdout") lastLine = line;
      options.streams[channel](line);
    }
    if (channel === "stdout") stdout = remainder; else stderr = remainder;
  };
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => consume(chunk, "stdout"));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => consume(chunk, "stderr"));
  child.once("message", (message: PaideiaProcessOutcome) => {
    outcome = message;
    if (message.type === "paideia.process.launch-error") error = failure(`Could not start Paideia: ${message.message}`);
    // The native child exited, but our supervisor still holds the group identity.
    // Stop stragglers before permitting its leader to disappear or reporting completion.
    kill("SIGKILL");
  });
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    clearTimeout(timer); clearTimeout(killTimer);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
    options.signal?.removeEventListener("abort", abort);
    const deadline = Date.now() + 1500;
    // Check only: never signal a numeric group identity after its supervisor was reaped.
    while ((groupExists() || !closed) && Date.now() < deadline) await delay(20);
    if (groupExists() || !closed) {
      error = failure("Paideia process cleanup is incomplete; group or output quiescence is unknown");
      child.stdout!.destroy(); child.stderr!.destroy();
    }
    if (stdout.trim()) { lastLine = stdout; options.streams.stdout(stdout); }
    if (stderr.trim()) options.streams.stderr(stderr);
    if (error) { reject(error); return; }
    if (stopCode !== undefined) { resolve(stopCode); return; }
    if (outcome?.type !== "paideia.process.exited") { reject(failure("Paideia supervisor exited without a native outcome")); return; }
    if (outcome.signal) { resolve(outcome.signal === "SIGINT" ? 130 : outcome.signal === "SIGTERM" ? 143 : 1); return; }
    const exitCode = outcome.code ?? 1;
    if ((exitCode === 0 || exitCode === 1) && !validReceipt(lastLine, options.dryRun)) {
      reject(failure("Paideia exited without the required final training receipt")); return;
    }
    resolve(exitCode);
  };
  child.once("error", (caught) => { error = failure(`Could not start Paideia supervisor: ${caught.message}`); });
  child.once("exit", () => { reaped = true; void finish(); });
  child.once("close", () => { closed = true; void finish(); });
});

/** Delegates through the public CLI, never importing Paideia or selecting a fallback adapter. */
export const delegatePaideiaTraining = async (options: DelegatePaideiaTrainingOptions): Promise<number> => {
  if (options.signal?.aborted) return 130;
  if (options.trainingConfig) {
    const config = await readBoundedJson(options.trainingConfig) as { version?: unknown };
    if (config.version === "spawnfile.training-container.v2") {
      if (options.trainingImage) throw failure("V2 owns its image declaration; --training-image is only for v1");
      const prepared = await prepareTraining({ configPath: options.trainingConfig, context: options.context, args: options.args,
        dryRun: options.dryRun, process: runTrainingDocker, timeoutMs: options.timeoutMs, signal: options.signal, streams: options.streams });
      if (!("dryRun" in prepared)) return launchTrainingContainer({ ...prepared,
        timeoutMs: options.timeoutMs, signal: options.signal, streams: options.streams });
      options.streams.stderr(`Training preparation plan ${prepared.digest}; no Docker, auth or filesystem mutations`);
    }
  }
  if (!options.dryRun) {
    if (!options.trainingImage || !options.trainingConfig) throw failure("Actual training requires --training-image and --training-config; host execution is disabled");
    return launchTrainingContainer({ image: options.trainingImage, configPath: options.trainingConfig,
      context: options.context, args: options.args, timeoutMs: options.timeoutMs, streams: options.streams, signal: options.signal });
  }
  if (process.platform === "win32") throw failure("Paideia delegation requires POSIX process-group supervision");
  const bytes = JSON.stringify(trainingContextSchema.parse(options.context));
  if (Buffer.byteLength(bytes, "utf8") > MAX_LINE_BYTES) throw new SpawnfileError("validation_error", "Training context exceeds 1 MiB");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-"));
  const contextPath = path.join(temporary, "context.json");
  try {
    await writeFile(contextPath, bytes, { mode: 0o600, flag: "wx" });
    return await runChild(options, contextPath);
  } finally { await rm(temporary, { recursive: true, force: true }); }
};
