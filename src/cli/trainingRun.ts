import path from "node:path";

import { TRIAL_CACHE_MODES, type TrialCacheMode } from "../compiler/training/trial/index.js";
import type { TrainingRunControls } from "../runtime/trainingTypes.js";
import { SpawnfileError } from "../shared/index.js";

export type { TrainingRunControls } from "../runtime/trainingTypes.js";

/** Validates the CLI's run controls; undefined values keep their defaults. */
export const parseTrainingRunControls = (options: Record<string, unknown>): TrainingRunControls => {
  const controls: TrainingRunControls = {};
  const cache = options.trialCache;
  if (cache !== undefined) {
    if (!TRIAL_CACHE_MODES.includes(cache as TrialCacheMode)) throw new SpawnfileError("validation_error", `--trial-cache must be one of ${TRIAL_CACHE_MODES.join(", ")}`);
    controls.trialCache = cache as TrialCacheMode;
  }
  if (typeof options.cacheDir === "string") controls.cacheDir = path.resolve(options.cacheDir);
  if (options.judgeConcurrency !== undefined) {
    const value = Number(options.judgeConcurrency);
    if (!/^\d+$/u.test(String(options.judgeConcurrency)) || value < 1 || value > 8) throw new SpawnfileError("validation_error", "--judge-concurrency must be an integer from 1 to 8");
    controls.judgeConcurrency = value;
  }
  if (options.realmLock !== undefined) {
    if (options.realmLock !== "wait" && options.realmLock !== "fail") throw new SpawnfileError("validation_error", "--realm-lock must be wait or fail");
    controls.realmLock = options.realmLock;
  }
  return controls;
};
