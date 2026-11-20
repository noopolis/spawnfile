import path from "node:path";

import { requireAuthProfile, resolveSpawnfileHome } from "../../../../auth/index.js";
import { createTrainingRealmLock, openTrialCacheStore, removeStaleRun } from "../../../../compiler/training/trial/index.js";
import type { RuntimeTrainingJudgeOptions } from "../../../index.js";
import { bindBootedJudges, bindBootedJudgmentCache } from "../booted/index.js";
import { createBootedTrialRun, type BootedTrialRun } from "./launcher.js";
import { openDaimonJudgmentCacheStore } from "./judgmentCache.js";

const DEFAULT_JUDGE_CONCURRENCY = 4;

export interface OpenTrainingRunOptions extends RuntimeTrainingJudgeOptions {
  /** The run's output directory: its scratch, claims ledger and lock label. */
  scratch: string;
  agentManifestPath?: string;
  projectManifestPath?: string;
}

/**
 * Opens one production-booted run: takes the auth profile's training realm (queued behind any other run on it),
 * then the run's trial and judgment caches, judges and gateway. `close` releases all of it, the realm last.
 */
export const openTrainingRun = async (options: OpenTrainingRunOptions): Promise<{ run: BootedTrialRun; close(): Promise<void> }> => {
  const authProfile = await requireAuthProfile(options.authProfile);
  const report = (line: string): void => options.streams.stderr(line);
  const lock = await createTrainingRealmLock({ profile: authProfile.name, mode: options.realmLock ?? "wait",
    label: path.resolve(options.out), report, ...(options.signal ? { signal: options.signal } : {}) });
  const release = lock.release;
  try {
    if (lock.stale) {
      // Its gateway would still hold the realm: no gateway of this run could start.
      report(`training realm of auth profile ${authProfile.name}: removing what run ${lock.stale.label} (pid ${lock.stale.pid}, gone) left: ${[...lock.stale.containers, ...lock.stale.networks].join(", ") || "nothing"}`);
      await removeStaleRun(lock.stale);
    }
    const mode = options.trialCache ?? "reuse";
    const root = options.cacheDir ?? path.join(resolveSpawnfileHome(), "training-cache");
    const scratchRoot = path.join(path.resolve(options.out), options.scratch);
    const run = createBootedTrialRun({
      authProfile, scratchRoot, report, own: lock.own, judgeConcurrency: options.judgeConcurrency ?? DEFAULT_JUDGE_CONCURRENCY,
      ...(options.agentManifestPath ? { agentManifestPath: options.agentManifestPath } : {}),
      ...(options.projectManifestPath ? { projectManifestPath: options.projectManifestPath } : {}),
      ...(mode === "off" ? {} : { cache: { mode, store: openTrialCacheStore(path.join(root, "trials"), path.join(scratchRoot, "trial-cache-claims.jsonl")) } })
    });
    bindBootedJudges(run, report);
    // Reuse replays proposals too, so an unchanged rerun (or a rerun after a crash) repeats the whole search for free;
    // fresh asks the optimizer again while identical articles still reuse their judgments.
    bindBootedJudgmentCache(mode === "off" ? undefined : openDaimonJudgmentCacheStore(root), { proposals: mode === "reuse" });
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
