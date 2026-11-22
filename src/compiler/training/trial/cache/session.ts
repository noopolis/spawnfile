import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../../../../shared/index.js";
import type { TrialWake } from "../types.js";
import { trialWakeKey, TRIAL_CACHE_VERSION } from "./digest.js";
import type { ClaimedEntry, TrialCacheEntry, TrialCacheMode, TrialCacheStore } from "./store.js";

type WakeOptions = { deliveryId: string; timeoutMs: number; signal?: AbortSignal };
/** The launcher's handle on one trial organization. */
export interface TrialHandle {
  readonly container: string;
  wake(text: string, options: WakeOptions): Promise<TrialWake>;
  read(file: string): Promise<string | null>;
  scanCredentials(): Promise<string[]>;
  teardown(): Promise<string | null>;
}

export interface CachedTrialOptions {
  store: TrialCacheStore;
  mode: TrialCacheMode;
  trialId: string;
  /** Compiled agent and moment (`trialBaseKey`). */
  base: string;
  evidenceDirectory: string;
  /** Boots the organization for real; called at most once. */
  boot(): Promise<TrialHandle>;
  /** Releases what was prepared for a boot that a replay made unnecessary. */
  discard(): Promise<void>;
  /** The run's operator channel. */
  report?: (line: string) => void;
}

/** A subject's own finished turn: completed, or deferred by its own choice. Anything else is never reused. */
const reusable = (wake: TrialWake): boolean => wake.state === "completed" || wake.state === "deferred" && wake.failure === null && wake.code === null;

const replay = (claimed: ClaimedEntry, evidenceDirectory: string): TrialHandle => {
  let wakes = 0;
  return {
    container: `cached:${claimed.id}`,
    scanCredentials: async () => [],
    wake: async (text, options) => {
      const recorded = claimed.entry.wakes[wakes];
      if (!recorded || recorded.text !== text || recorded.timeoutMs !== options.timeoutMs) {
        throw new SpawnfileError("runtime_error", `cached trial ${claimed.id} diverged at wake ${wakes + 1}: it holds no identical wake to replay`);
      }
      wakes++;
      return { ...structuredClone(recorded.result), reusedFrom: claimed.entry.trialId };
    },
    read: async (file) => {
      const reads = claimed.entry.reads[wakes] ?? {};
      if (!Object.hasOwn(reads, file)) throw new SpawnfileError("runtime_error", `cached trial ${claimed.id} never read ${file}; it cannot answer for it`);
      return reads[file]!;
    },
    teardown: async () => {
      await mkdir(evidenceDirectory, { recursive: true });
      await cp(claimed.evidence, evidenceDirectory, { recursive: true }).catch(() => undefined);
      await writeFile(path.join(evidenceDirectory, "reused-from.json"), `${JSON.stringify({ entry: claimed.id, trialId: claimed.entry.trialId, recordedAt: claimed.entry.recordedAt })}\n`);
      return claimed.entry.teardown;
    }
  };
};

/**
 * One trial through the run's trial cache. A trial whose compiled agent and moment were never recorded boots at
 * once, exactly as without a cache. Otherwise the first wake decides: an identical recorded trial this run has not
 * counted yet is replayed (nothing boots), else the organization boots then. A fresh trial that finished cleanly is
 * recorded at teardown with its evidence.
 */
export const cachedTrial = async (options: CachedTrialOptions): Promise<TrialHandle> => {
  let live: TrialHandle | undefined;
  let replayed: TrialHandle | undefined;
  let wakeKey: string | undefined;
  const entry: TrialCacheEntry = { schema: TRIAL_CACHE_VERSION, trialId: options.trialId, recordedAt: "", wakes: [], reads: [{}], teardown: null };
  if (options.mode !== "reuse" || !(await options.store.known(options.base))) live = await options.boot();
  const decide = async (text: string, timeoutMs: number): Promise<TrialHandle> => {
    if (live ?? replayed) return (live ?? replayed)!;
    const claimed = await options.store.claim(options.base, trialWakeKey(text, timeoutMs), options.trialId);
    if (!claimed) return live = await options.boot();
    options.report?.(`training trial ${options.trialId} reuses cached trial ${claimed.entry.trialId} (${claimed.id})`);
    await options.discard();
    return replayed = replay(claimed, options.evidenceDirectory);
  };
  return {
    get container() { return (live ?? replayed)?.container ?? ""; },
    scanCredentials: async () => live?.scanCredentials() ?? [],
    wake: async (text, wakeOptions) => {
      const handle = await decide(text, wakeOptions.timeoutMs);
      const result = await handle.wake(text, wakeOptions);
      if (handle === live) {
        wakeKey ??= trialWakeKey(text, wakeOptions.timeoutMs);
        entry.wakes.push({ text, timeoutMs: wakeOptions.timeoutMs, result: structuredClone(result) });
        entry.reads.push({});
      }
      return result;
    },
    read: async (file) => {
      const handle = live ?? replayed;
      if (!handle) return null;
      const text = await handle.read(file);
      if (handle === live) entry.reads[entry.wakes.length]![file] = text;
      return text;
    },
    teardown: async () => {
      if (replayed) return replayed.teardown();
      if (!live) { await options.discard(); return null; }
      const failure = await live.teardown();
      if (options.mode !== "off" && wakeKey && failure === null && entry.wakes.every(({ result }) => reusable(result))) {
        entry.teardown = failure;
        entry.recordedAt = new Date().toISOString();
        await options.store.record(options.base, wakeKey, entry, options.evidenceDirectory)
          .catch((error: Error) => options.report?.(`training trial ${options.trialId} could not be cached: ${error.message}`));
      }
      return failure;
    }
  };
};
