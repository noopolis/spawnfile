import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TrialWake } from "../types.js";
import { TRIAL_CACHE_VERSION } from "./digest.js";

/**
 * `reuse` replays an identical earlier trial when one is unclaimed by this run, and records every fresh one;
 * `fresh` never replays but still records (repeats that measure one prompt's stability); `off` does neither.
 */
export type TrialCacheMode = "reuse" | "fresh" | "off";
export const TRIAL_CACHE_MODES: readonly TrialCacheMode[] = ["reuse", "fresh", "off"];

/** One finished trial as its organization answered it: every wake in order, every output read after each. */
export interface TrialCacheEntry {
  schema: typeof TRIAL_CACHE_VERSION;
  /** The trial that measured it, and when. */
  trialId: string;
  recordedAt: string;
  wakes: { text: string; timeoutMs: number; result: TrialWake }[];
  /** `reads[n]`: each workspace output read after `n` wakes, as last read. */
  reads: Record<string, string | null>[];
  teardown: string | null;
}

export interface ClaimedEntry { id: string; entry: TrialCacheEntry; evidence: string }

export interface TrialCacheStore {
  readonly root: string;
  /** Whether any trial was ever recorded for this compiled agent and moment. */
  known(base: string): Promise<boolean>;
  /** The oldest recorded trial for this key that this run has not counted yet, now counted for `trialId`. */
  claim(base: string, wake: string, trialId: string): Promise<ClaimedEntry | undefined>;
  /** Records a finished fresh trial, counted for this run at once so no later trial of the run replays it. */
  record(base: string, wake: string, entry: TrialCacheEntry, evidenceDirectory: string | undefined): Promise<string>;
}

const ENTRY = "entry.json";

/**
 * The cache lives outside any run (`root`), keyed by content; the run's own claims ledger (`claimsFile`, in the run's
 * output) is what keeps one recorded trial from counting twice in one run, across a stop and a resume as well.
 */
export const openTrialCacheStore = (root: string, claimsFile: string): TrialCacheStore => {
  let claims: Promise<Set<string>> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const claimed = (): Promise<Set<string>> => claims ??= readFile(claimsFile, "utf8").then(
    (text) => new Set(text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { entry: string }).entry)),
    (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return new Set<string>(); throw error; });
  const count = async (id: string, trialId: string): Promise<void> => {
    await mkdir(path.dirname(claimsFile), { recursive: true });
    await appendFile(claimsFile, `${JSON.stringify({ entry: id, trialId })}\n`, { mode: 0o600 });
    (await claimed()).add(id);
  };
  const indexes = async (directory: string): Promise<number[]> => (await readdir(directory).catch(() => []))
    .filter((name) => /^\d+$/u.test(name)).map(Number).sort((left, right) => left - right);
  return {
    root,
    known: async (base) => (await readdir(path.join(root, base)).catch(() => [])).some((name) => /^[0-9a-f]{64}$/u.test(name)),
    claim: (base, wake, trialId) => serial(async () => {
      const taken = await claimed();
      for (const index of await indexes(path.join(root, base, wake))) {
        const id = `${base}/${wake}/${index}`;
        if (taken.has(id)) continue;
        const directory = path.join(root, id);
        const entry = await readFile(path.join(directory, ENTRY), "utf8").then((text) => JSON.parse(text) as TrialCacheEntry, () => undefined);
        if (entry?.schema !== TRIAL_CACHE_VERSION) continue;
        await count(id, trialId);
        return { id, entry, evidence: path.join(directory, "evidence") };
      }
      return undefined;
    }),
    record: (base, wake, entry, evidenceDirectory) => serial(async () => {
      const parent = path.join(root, base, wake);
      const staging = path.join(parent, `.staging-${randomUUID()}`);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      try {
        if (evidenceDirectory) await cp(evidenceDirectory, path.join(staging, "evidence"), { recursive: true }).catch(() => undefined);
        await writeFile(path.join(staging, ENTRY), JSON.stringify(entry), { mode: 0o600 });
        // Another run may record the same key at once: the first rename to a free index wins, the other takes the next.
        for (let index = (await indexes(parent)).at(-1) ?? -1; ; ) {
          index++;
          try {
            await rename(staging, path.join(parent, String(index)));
            const id = `${base}/${wake}/${index}`;
            await count(id, entry.trialId);
            return id;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
          }
        }
      } finally { await rm(staging, { recursive: true, force: true }); }
    })
  };
};
