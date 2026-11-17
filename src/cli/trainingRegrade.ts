import { regradeTraining } from "../runtime/trainingRegrade.js";
import { SpawnfileError } from "../shared/index.js";
import type { CliStreams } from "./runCli.js";
import { openTrainingRun, type TrainingRunControls } from "./trainingRun.js";

export interface RunTrainingRegradeOptions {
  manifest: string;
  out: string;
  authProfile?: string;
  concurrency?: number;
  controls?: TrainingRunControls;
  streams: CliStreams;
  signal?: AbortSignal;
}

/**
 * `spawnfile train --regrade <manifest>`: recorded outputs graded on the run's booted judges, which hold
 * their login through the run's auth gateway exactly as in training. The run has no subject and boots no trial.
 */
export const runTrainingRegrade = async (options: RunTrainingRegradeOptions): Promise<number> => {
  if (!options.authProfile) throw new SpawnfileError("validation_error", "A regrade asks the run's booted judges; pass --auth-profile (the login its auth gateway holds)");
  const { close } = await openTrainingRun({ ...options.controls, authProfile: options.authProfile, out: options.out, scratch: "booted-judges",
    streams: options.streams, ...(options.signal ? { signal: options.signal } : {}) });
  try {
    return await regradeTraining({ manifest: options.manifest, out: options.out, concurrency: options.concurrency, streams: options.streams, signal: options.signal });
  } finally {
    await close();
  }
};
