import { type TrainingContext, type TrainingExecution } from "../compiler/training/index.js";
import { launchTrainingContainer } from "../compiler/training/container/index.js";
import { runTrainingDocker } from "../compiler/training/container/process.js";
import { prepareTraining } from "../compiler/training/preparation/index.js";
import { readBoundedJson } from "../compiler/training/preparation/inputs.js";
import { main as trainingMain } from "../runtime/trainingCli.js";
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
  let signalExit: number | undefined;
  const interrupt = (): void => { signalExit = 130; controller.abort(); };
  const terminate = (): void => { signalExit = 143; controller.abort(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try {
    const code = await trainingMain(["train", ...options.args], {
      cwd: process.cwd(),
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
      stdout: text => options.streams.stdout(text.replace(/\n$/u, "")),
      stderr: text => options.streams.stderr(text.replace(/\n$/u, ""))
    }, { spawnfileContext: options.context });
    return signalExit ?? code;
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
  }
};
