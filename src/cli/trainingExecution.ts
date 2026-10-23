import { canonicalWireId } from '../shared/index.js';
import { type TrainingContext, type TrainingExecution } from "../compiler/training/index.js";
import { launchTrainingContainer } from "../compiler/training/container/index.js";
import { runTrainingDocker } from "../compiler/training/container/process.js";
import { prepareTraining } from "../compiler/training/preparation/index.js";
import { readBoundedJson } from "../compiler/training/preparation/inputs.js";
import { SpawnfileError } from "../shared/index.js";
import type { CliStreams } from "./runCli.js";

export interface RunTrainingOptions {
  context: TrainingContext;
  execution?: TrainingExecution;
  args: readonly string[];
  dryRun: boolean;
  repairMeasurements?: string; repairWitness?: string;
  trainingImage?: string;
  trainingConfig?: string;
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

/** Owns image preparation/launch and invokes host estimates through the training composition. */
export const runTraining = async (options: RunTrainingOptions): Promise<number> => {
  if (options.signal?.aborted) return 130;
  if (options.repairWitness && !options.repairMeasurements) throw failure("--repair-witness requires --repair-measurements");
  if (options.trainingConfig) {
    const config = await readBoundedJson(options.trainingConfig) as { version?: unknown; image?: unknown };
    // Image declarations go through preparation; lowered launch configurations go straight to Docker.
    if (config.version === "spawnfile.training-container.v2" || (["spawnfile.training-container.v3", "spawnfile.training-container.v4"].includes(String(config.version)) && config.image !== undefined)) {
      if (options.trainingImage && !options.execution) throw failure("V2 owns its image declaration; --training-image is only for v1");
      const prepared = await prepareTraining({ configPath: options.trainingConfig, context: options.context, args: options.args,
        repairMeasurements: options.repairMeasurements, repairWitness: options.repairWitness,
        execution: options.execution, outputOverride: options.execution?.output, imageOverride: options.execution ? options.trainingImage : undefined,
        dryRun: options.dryRun, process: runTrainingDocker, timeoutMs: options.timeoutMs, signal: options.signal, streams: options.streams });
      if (!("dryRun" in prepared)) return launchTrainingContainer({ ...prepared,
        timeoutMs: options.timeoutMs, signal: options.signal, streams: options.streams });
      options.streams.stderr(`Training preparation plan ${prepared.digest}; no Docker, auth or filesystem mutations`);
      options = { ...options, repairMeasurements: undefined, repairWitness: undefined };
    }
  }
  if (options.repairMeasurements) throw failure("Measurement repair requires the v2 preparation declaration");
  if (!options.dryRun) {
    if (!options.trainingImage || !options.trainingConfig) throw failure("Actual training requires --training-image and --training-config; host execution is disabled");
    return launchTrainingContainer({ image: options.trainingImage, configPath: options.trainingConfig,
      context: options.context, args: options.args, execution: options.execution, timeoutMs: options.timeoutMs, streams: options.streams, signal: options.signal });
  }
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
