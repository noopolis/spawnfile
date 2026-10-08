import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveSpawnfileHome } from "../auth/paths.js";

import { validateWorkspaceBundleTar } from "./workspaceBundleArtifacts.js";
import type { BundleTarSummary } from "./workspaceBundleTar.js";

const RECORD_VERSION = "spawnfile.workspace-bundle-cache.v1";
/** Built archives kept per cache directory; the least recently used beyond this are pruned. */
export const WORKSPACE_BUNDLE_CACHE_LIMIT = 24;

export interface CachedBundle extends BundleTarSummary {
  key: string;
  tarPath: string;
}

interface CacheRecord extends BundleTarSummary {
  ino: number;
  key: string;
  mtimeMs: number;
  version: typeof RECORD_VERSION;
}

export const resolveWorkspaceBundleCacheDirectory = (override?: string): string =>
  override ?? path.join(resolveSpawnfileHome(), "cache", "workspace-bundles");

const paths = (directory: string, key: string) => ({ record: path.join(directory, `${key}.json`), tar: path.join(directory, `${key}.tar`) });

/**
 * A hit is a record whose archive still has the size, inode and mtime it had
 * when it was written. Anything else — a missing, replaced or edited archive,
 * an unreadable record — is a miss and the archive is rebuilt.
 */
export const lookupCachedBundle = async (directory: string, key: string): Promise<CachedBundle | undefined> => {
  const location = paths(directory, key);
  try {
    const record = JSON.parse(await readFile(location.record, "utf8")) as Partial<CacheRecord>;
    const info = await stat(location.tar);
    if (record.version !== RECORD_VERSION || record.key !== key || !info.isFile() || (info.mode & 0o222) !== 0 || info.size !== record.size || info.ino !== record.ino || info.mtimeMs !== record.mtimeMs || typeof record.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.sha256)) return undefined;
    const now = new Date();
    await utimes(location.record, now, now).catch(() => undefined);
    return { contentBytes: record.contentBytes!, fileCount: record.fileCount!, key, sha256: record.sha256 as `sha256:${string}`, size: record.size!, tarPath: location.tar };
  } catch {
    return undefined;
  }
};

/** Builds into a private temporary file, validates it, then publishes archive and record by atomic rename. */
export const storeBuiltBundle = async (
  directory: string,
  key: string,
  build: (temporaryPath: string) => Promise<BundleTarSummary>
): Promise<CachedBundle> => {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const location = paths(directory, key), suffix = `${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const temporaryTar = `${location.tar}.${suffix}`, temporaryRecord = `${location.record}.${suffix}`;
  try {
    const summary = await build(temporaryTar);
    validateWorkspaceBundleTar(await readFile(temporaryTar));
    // Read-only: staging hard-links this inode into build contexts, which must never write through to it.
    await chmod(temporaryTar, 0o444);
    await rename(temporaryTar, location.tar);
    const info = await stat(location.tar);
    const record: CacheRecord = { ...summary, ino: info.ino, key, mtimeMs: info.mtimeMs, version: RECORD_VERSION };
    await writeFile(temporaryRecord, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporaryRecord, location.record);
    return { ...summary, key, tarPath: location.tar };
  } finally {
    await rm(temporaryTar, { force: true });
    await rm(temporaryRecord, { force: true });
  }
};

/** An archive used this recently may belong to a concurrent compile that has not staged it yet. */
export const WORKSPACE_BUNDLE_CACHE_GRACE_MS = 3_600_000;

/**
 * Removes the least recently used archives beyond the limit. Never removes
 * one this compile uses, nor one any compile used within the grace period.
 */
export const pruneBundleCache = async (directory: string, keep: ReadonlySet<string>, limit = WORKSPACE_BUNDLE_CACHE_LIMIT, now = Date.now()): Promise<void> => {
  const names = await readdir(directory).catch(() => [] as string[]);
  const records = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map(async (name) => ({
    key: name.slice(0, 64), used: (await stat(path.join(directory, name)).catch(() => undefined))?.mtimeMs ?? 0
  })));
  const stale = records.sort((left, right) => right.used - left.used).slice(limit).filter((record) => !keep.has(record.key) && now - record.used > WORKSPACE_BUNDLE_CACHE_GRACE_MS);
  await Promise.all(stale.flatMap((record) => [
    rm(path.join(directory, `${record.key}.json`), { force: true }),
    rm(path.join(directory, `${record.key}.tar`), { force: true })
  ]));
};
