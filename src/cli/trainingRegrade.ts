import path from "node:path";

import { requireAuthProfile } from "../auth/index.js";
import { createBootedTrialRun } from "../compiler/training/trial/index.js";
import { bindBootedJudges } from "../runtime/daimon/training/booted/index.js";
import { regradeTraining } from "../runtime/trainingRegrade.js";
import { SpawnfileError } from "../shared/index.js";
import type { CliStreams } from "./runCli.js";

export interface RunTrainingRegradeOptions {
  manifest: string;
  out: string;
  authProfile?: string;
  concurrency?: number;
  streams: CliStreams;
  signal?: AbortSignal;
}

/**
 * `spawnfile train --regrade <manifest>`: recorded outputs graded on the run's booted judges, which hold
 * their login through the run's auth gateway exactly as in training. The run has no subject and boots no trial.
 */
export const runTrainingRegrade = async (options: RunTrainingRegradeOptions): Promise<number> => {
  if (!options.authProfile) throw new SpawnfileError("validation_error", "A regrade asks the run's booted judges; pass --auth-profile (the login its auth gateway holds)");
  const run = createBootedTrialRun({ authProfile: await requireAuthProfile(options.authProfile), scratchRoot: path.join(path.resolve(options.out), "booted-judges") });
  bindBootedJudges(run, (line) => options.streams.stderr(line));
  try {
    return await regradeTraining({ manifest: options.manifest, out: options.out, concurrency: options.concurrency, streams: options.streams, signal: options.signal });
  } finally {
    bindBootedJudges(undefined);
    await run.close();
  }
};
