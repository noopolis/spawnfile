import { randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { resolveSpawnfileHome } from "../../../auth/paths.js";

const VERSION = "spawnfile.training-seal-memo.v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Private same-user cache of plan-side source digests. It never replaces the full
 * rehash of staged build-context copies, so image bytes stay verified on every build.
 */
export interface SealMemo {
  lookup(source: string, stat: BigIntStats): string | undefined;
  /** Stores only racily-clean digests: metadata older than the safety window at hash start. */
  record(source: string, stat: BigIntStats, sha256: string, hashStartedNs: bigint): void;
  save(): Promise<void>;
}

export interface SealMemoOptions { maxEntries?: number; racySafetyNs?: bigint }

export const trainingSealMemoPath = (): string => path.join(resolveSpawnfileHome(), "cache", "training-seal.v1.json");

export const sealMemoKey = (source: string, stat: BigIntStats): string =>
  JSON.stringify([source, stat.dev.toString(), stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()]);

async function readTrusted(file: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) return entries;
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== VERSION) return entries;
    const raw = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(raw)) return entries;
    for (const item of raw) {
      if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string" && DIGEST.test(item[1])) {
        entries.set(item[0], item[1]);
      }
    }
  } catch { return new Map(); }
  return entries;
}

export async function openSealMemo(file = trainingSealMemoPath(), options: SealMemoOptions = {}): Promise<SealMemo> {
  const maxEntries = options.maxEntries ?? 20_000;
  const racySafetyNs = options.racySafetyNs ?? 2_000_000_000n;
  const previous = await readTrusted(file);
  const touched = new Map<string, string>();
  let dirty = false;
  return {
    lookup(source, stat) {
      const key = sealMemoKey(source, stat);
      const found = touched.get(key) ?? previous.get(key);
      if (found !== undefined) touched.set(key, found);
      return found;
    },
    record(source, stat, sha256, hashStartedNs) {
      if (!DIGEST.test(sha256)) return;
      const newest = stat.ctimeNs > stat.mtimeNs ? stat.ctimeNs : stat.mtimeNs;
      if (newest > hashStartedNs - racySafetyNs) return;
      touched.set(sealMemoKey(source, stat), sha256); dirty = true;
    },
    async save() {
      const retained = [...touched];
      for (const entry of [...previous].reverse()) {
        if (retained.length >= maxEntries) break;
        if (!touched.has(entry[0])) retained.push(entry);
      }
      if (!dirty && retained.length === previous.size) return;
      const bounded = retained.slice(0, maxEntries).reverse();
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ version: VERSION, entries: bounded })); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
        dirty = false;
      } catch { await rm(temporary, { force: true }).catch(() => undefined); }
    }
  };
}
