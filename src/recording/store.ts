import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { acquirePidLock } from "../deployment/pidLock.js";
import { syncDirectory, writeDurableFile } from "../filesystem/index.js";
import type { MomentRecord } from "./types.js";

/** Project records share a directory, so each gets its own state subdirectory. */
export const deploymentMomentsDirectory = (recordPath: string): string => path.join(
  path.dirname(recordPath), ...(path.basename(recordPath) === "record.json" ? [] : [path.basename(recordPath, ".json")]), "moments"
);

export const momentFileName = (startedAt: string, executionId: string): string => {
  const compact = new Date(startedAt).toISOString().replace(/[-:.]/gu, "");
  const safeId = /^[A-Za-z0-9._-]{1,128}$/u.test(executionId)
    ? executionId : `sha256-${createHash("sha256").update(executionId).digest("hex")}`;
  return `${compact}-${safeId}.json`;
};

const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Moment directory is not a real directory: ${directory}`);
};

export const withMomentStore = async <T>(recordPath: string, slug: string, action: (directory: string) => Promise<T>): Promise<T> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(slug)) throw new Error("Unsafe recording agent slug");
  const root = deploymentMomentsDirectory(recordPath);
  await ensurePrivateDirectory(root);
  const directory = path.join(root, slug);
  await ensurePrivateDirectory(directory);
  const release = await acquirePidLock(path.join(directory, ".sync.lock"));
  try { return await action(directory); } finally { await release(); }
};

/** Caller holds the store lock. Existing records are never replaced, including non-exact ones. */
export const writeMomentRecord = async (directory: string, record: MomentRecord): Promise<boolean> => {
  const file = path.join(directory, momentFileName(record.wake.startedAt, record.wake.executionId));
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Moment is not a regular file: ${file}`);
    const existing = JSON.parse(await readFile(file, "utf8")) as MomentRecord;
    if (existing.agent !== record.agent || existing.wake?.executionId !== record.wake.executionId
      || existing.wake?.startedAt !== record.wake.startedAt) throw new Error(`Moment filename collision: ${file}`);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeDurableFile(file, `${JSON.stringify(record, null, 2)}\n`);
  return true;
};

const storedMoments = async (directory: string, agentId: string): Promise<Array<{ file: string; started: number }>> => {
  const candidates: Array<{ file: string; started: number }> = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Moment is not a regular file: ${file}`);
    const record = JSON.parse(await readFile(file, "utf8")) as MomentRecord;
    const started = Date.parse(record.wake?.startedAt);
    if (record.version !== "spawnfile.moment-record.v1" || record.agent !== agentId || !Number.isFinite(started)) {
      throw new Error(`Invalid retained moment: ${file}`);
    }
    candidates.push({ file, started });
  }
  return candidates;
};

export const newestMomentInstant = async (directory: string, agentId: string): Promise<number> =>
  (await storedMoments(directory, agentId)).reduce((latest, item) => Math.max(latest, item.started), -Infinity);

/** Retention reads the recorded instant, never mtime; preserve all newest-instant ties. */
export const pruneMomentRecords = async (directory: string, agentId: string, now: Date, keepMs: number): Promise<void> => {
  const candidates = await storedMoments(directory, agentId);
  const newest = candidates.reduce((latest, item) => Math.max(latest, item.started), -Infinity);
  const expired = candidates.filter((item) => item.started < newest && item.started < now.getTime() - keepMs);
  for (const item of expired) await unlink(item.file);
  if (expired.length) await syncDirectory(directory);
};
