import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { JUDGE_INSTRUCTIONS } from "../judge.js";

/** Bumped whenever what a cached judgment means changes. */
export const JUDGMENT_CACHE_VERSION = "spawnfile.training.judgment-cache.v1";

export interface JudgmentCacheStore {
  take(key: string): Promise<{ occurrence: number; reply?: string }>;
  put(key: string, occurrence: number, reply: string): Promise<void>;
}

/**
 * Valid judge replies under `root/judgments`, one file per occurrence of an identical request: the judge
 * identity and the whole wake text (article, question bank, schema). A changed grader asks a different
 * question, so it is judged again; the n-th identical request of a process reads the n-th reply, so repeats
 * stay separate samples.
 */
export const openJudgmentCacheStore = (root: string, reuse = true): JudgmentCacheStore => {
  const seen = new Map<string, number>();
  const directory = (key: string): string => path.join(root, "judgments",
    createHash("sha256").update(JSON.stringify([JUDGMENT_CACHE_VERSION, JUDGE_INSTRUCTIONS, key])).digest("hex"));
  return {
    take: async (key) => {
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      if (!reuse) return { occurrence };
      const reply = await readFile(path.join(directory(key), `${occurrence}.json`), "utf8")
        .then((text) => (JSON.parse(text) as { reply?: unknown }).reply, () => undefined);
      return typeof reply === "string" ? { occurrence, reply } : { occurrence };
    },
    put: async (key, occurrence, reply) => {
      await mkdir(directory(key), { recursive: true, mode: 0o700 });
      // Written whole, then linked into place: a reader never sees half a reply, and the first writer keeps the slot.
      const staging = path.join(directory(key), `.staging-${randomUUID()}`);
      await writeFile(staging, JSON.stringify({ reply, recordedAt: new Date().toISOString() }), { mode: 0o600 });
      try {
        await link(staging, path.join(directory(key), `${occurrence}.json`))
          .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      } finally { await rm(staging, { force: true }); }
    }
  };
};
