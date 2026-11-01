import { canonicalWireId } from '../shared/index.js';
import type { TrainingContext } from "../compiler/training/index.js";
import { SpawnfileError } from "../shared/index.js";
import type { CliStreams } from "./runCli.js";
import { runBootedTraining } from "./trainingBooted.js";

export interface RunTrainingOptions {
  context: TrainingContext;
  args: readonly string[];
  dryRun: boolean;
  /** Auth profile whose login a production-booted run's gateway holds. */
  authProfile?: string;
  timeoutMs: number;
  streams: CliStreams;
  signal?: AbortSignal;
}

const failure = (message: string): SpawnfileError => new SpawnfileError("runtime_error", message);
const validCostReceipt = (line: string): boolean => {
  try {
    const receipt: unknown = JSON.parse(line);
    return typeof receipt === "object" && receipt !== null &&
      "schema" in receipt && canonicalWireId(receipt.schema) === "spawnfile.training.training-cost-plan.v1" &&
      "modelCallsMade" in receipt && receipt.modelCallsMade === 0;
  } catch { return false; }
};

/** Actual training boots production trials; dry-run estimates run on the host through the training composition. */
export const runTraining = async (options: RunTrainingOptions): Promise<number> => {
  if (options.signal?.aborted) return 130;
  if (!options.dryRun) return runBootedTraining(options);
  const controller = new AbortController();
  const deadline = performance.now() + options.timeoutMs;
  let active = true, lastLine = "";
  const pending = { stdout: "", stderr: "" };
  let stop!: (code: number, error?: Error) => void;
  const stopped = new Promise<number>((resolve, reject) => {
    stop = (code, error) => {
      if (!active) return;
      active = false;
      if (error) reject(error); else resolve(code);
      controller.abort(error);
    };
  });
  const expire = (): void => stop(1, failure("Training exceeded its command deadline"));
  const interrupt = (): void => stop(130);
  const terminate = (): void => stop(143);
  const timer = setTimeout(expire, options.timeoutMs);
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  options.signal?.addEventListener("abort", interrupt, { once: true });
  const emit = (channel: "stdout" | "stderr", raw: string): void => {
    if (performance.now() >= deadline) expire();
    if (!active) return;
    const line = raw.replace(/\r$/u, "");
    if (!line.trim()) return;
    if (channel === "stdout") lastLine = line;
    options.streams[channel](line);
  };
  const flush = (): void => {
    for (const channel of ["stdout", "stderr"] as const) {
      const text = pending[channel]; pending[channel] = ""; emit(channel, text);
    }
  };
  const forward = (channel: "stdout" | "stderr", text: string): void => {
    if (performance.now() >= deadline) expire();
    if (!active) return;
    const lines = (pending[channel] + text).split("\n");
    pending[channel] = lines.pop()!;
    for (const line of lines) emit(channel, line);
  };
  try {
    const invocation = async (): Promise<number> => {
      const { main: trainingMain } = await import("../runtime/trainingCli.js");
      if (performance.now() >= deadline) expire();
      if (!active) return stopped;
      const args = options.args.includes("--dry-run") ? options.args : [...options.args, "--dry-run"];
      return trainingMain(["train", ...args], {
        cwd: process.cwd(), signal: controller.signal,
        stdout: text => forward("stdout", text), stderr: text => forward("stderr", text)
      }, { spawnfileContext: options.context });
    };
    if (options.signal?.aborted) interrupt();
    const code = await Promise.race([stopped, invocation()]);
    // Synchronous core work can delay the timer; elapsed time still forbids success.
    if (active && performance.now() >= deadline) { expire(); return await stopped; }
    if (active) flush();
    if (active && performance.now() >= deadline) expire();
    if (!active) return await stopped;
    if (active && code === 0 && !validCostReceipt(lastLine)) {
      throw failure("Training exited without the required final training receipt");
    }
    return code;
  } catch (error) {
    if (active) flush();
    if (active && performance.now() >= deadline) expire();
    if (!active) return await stopped;
    throw error;
  } finally {
    active = false;
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
    options.signal?.removeEventListener("abort", interrupt);
  }
};
