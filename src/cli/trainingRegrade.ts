import { regradeTraining } from "../runtime/trainingRegrade.js";
import { SpawnfileError } from "../shared/index.js";
import type { CliStreams } from "./runCli.js";
import type { TrainingRunControls } from "../runtime/trainingTypes.js";

export interface RunTrainingRegradeOptions {
  manifest: string;
  out: string;
  authProfile?: string;
  concurrency?: number;
  controls?: TrainingRunControls;
  streams: CliStreams;
  signal?: AbortSignal;
}

/** Grade recorded outputs using the runtime that owns the declared judge providers. */
export const runTrainingRegrade = async (options: RunTrainingRegradeOptions): Promise<number> => {
  const { authProfile } = options;
  if (!authProfile) throw new SpawnfileError("validation_error", "Regrade requires --auth-profile");
  return regradeTraining({
    manifest: options.manifest, out: options.out, concurrency: options.concurrency, streams: options.streams,
    signal: options.signal,
    async openJudges(providers, composition) {
      const runtimes = new Map(providers.flatMap((provider) => {
        const owner = composition.owners.get(provider);
        return owner?.training?.openJudges ? [[owner.name, owner.training] as const] : [];
      }));
      if (runtimes.size > 1) {
        throw new SpawnfileError("validation_error", `Regrade uses judge providers from multiple runtime hosts: ${[...runtimes.keys()].join(", ")}`);
      }
      return runtimes.values().next().value?.openJudges?.({ ...options.controls, authProfile, out: options.out,
        streams: options.streams, signal: options.signal });
    }
  });
};
