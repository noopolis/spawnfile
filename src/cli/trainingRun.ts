import path from "node:path";

import { requireAuthProfile, resolveSpawnfileHome } from "../auth/index.js";
import {
  createBootedTrialRun, createTrainingRealmLock, openJudgmentCacheStore, openTrialCacheStore, TRIAL_CACHE_MODES,
  type BootedTrialRun, type TrialCacheMode
} from "../compiler/training/trial/index.js";
import { bindBootedJudges, bindBootedJudgmentCache } from "../runtime/daimon/training/booted/index.js";
import { SpawnfileError } from "../shared/index.js";
import type { CliStreams } from "./runCli.js";

/** How a production-booted run shares its realm, its cache and its judges; every field has a default. */
export interface TrainingRunControls {
  /** `reuse` (default), `fresh` or `off`: see `trial/cache/store.ts`. */
  trialCache?: TrialCacheMode;
  /** Cache root kept across runs (default `<spawnfile home>/training-cache`). */
  cacheDir?: string;
  /** Warm judge containers per judge identity (default 4). */
  judgeConcurrency?: number;
  /** A second run on a held auth profile waits (default) or fails at once. */
  realmLock?: "wait" | "fail";
}

export const DEFAULT_JUDGE_CONCURRENCY = 4;

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

export interface OpenTrainingRunOptions extends TrainingRunControls {
  authProfile: string;
  /** The run's output directory: its scratch, claims ledger and lock label. */
  out: string;
  scratch: string;
  agentManifestPath?: string;
  projectManifestPath?: string;
  streams: CliStreams;
  signal?: AbortSignal;
}

/**
 * Opens one production-booted run: takes the auth profile's training realm (queued behind any other run on it),
 * then the run's trial and judgment caches, judges and gateway. `close` releases all of it, the realm last.
 */
export const openTrainingRun = async (options: OpenTrainingRunOptions): Promise<{ run: BootedTrialRun; close(): Promise<void> }> => {
  const authProfile = await requireAuthProfile(options.authProfile);
  const report = (line: string): void => options.streams.stderr(line);
  const release = await createTrainingRealmLock({ profile: authProfile.name, mode: options.realmLock ?? "wait",
    label: path.resolve(options.out), report, ...(options.signal ? { signal: options.signal } : {}) });
  try {
    const mode = options.trialCache ?? "reuse";
    const root = options.cacheDir ?? path.join(resolveSpawnfileHome(), "training-cache");
    const scratchRoot = path.join(path.resolve(options.out), options.scratch);
    const run = createBootedTrialRun({
      authProfile, scratchRoot, report, judgeConcurrency: options.judgeConcurrency ?? DEFAULT_JUDGE_CONCURRENCY,
      ...(options.agentManifestPath ? { agentManifestPath: options.agentManifestPath } : {}),
      ...(options.projectManifestPath ? { projectManifestPath: options.projectManifestPath } : {}),
      ...(mode === "off" ? {} : { cache: { mode, store: openTrialCacheStore(path.join(root, "trials"), path.join(scratchRoot, "trial-cache-claims.jsonl")) } })
    });
    bindBootedJudges(run, report);
    // Reuse replays proposals too, so an unchanged rerun (or a rerun after a crash) repeats the whole search for free;
    // fresh asks the optimizer again while identical articles still reuse their judgments.
    bindBootedJudgmentCache(mode === "off" ? undefined : openJudgmentCacheStore(root), { proposals: mode === "reuse" });
    return { run, close: async () => {
      try {
        bindBootedJudges(undefined);
        bindBootedJudgmentCache(undefined);
        await run.close();
      } finally { await release(); }
    } };
  } catch (error) {
    await release();
    throw error;
  }
};
