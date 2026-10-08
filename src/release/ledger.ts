import { randomUUID } from "node:crypto";
import { appendFile, chmod, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { resolveSpawnfileHome } from "../auth/index.js";
import { normalizeDeploymentName } from "../deployment/index.js";

import { ReleaseError } from "./types.js";

export const RELEASE_LEDGER_VERSION = "spawnfile.release-ledger.v1" as const;
export const RELEASE_LOG_VERSION = "spawnfile.release-log.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timings = z.object({
  build_ms: z.number().nonnegative().nullable(),
  compile_ms: z.number().nonnegative(),
  deploy_ms: z.number().nonnegative().nullable(),
  drain_ms: z.number().nonnegative().nullable(),
  total_ms: z.number().nonnegative()
}).strict();

/** What is running, as the last successful release recorded it. */
export const releaseLedgerSchema = z.object({
  compile_fingerprint: z.string().min(1),
  deployment: z.string().min(1),
  identity: digest,
  image_id: z.string().min(1),
  image_tag: z.string().min(1),
  previous_image_tag: z.string().min(1).nullable(),
  released_at: z.string().min(1),
  timings,
  version: z.literal(RELEASE_LEDGER_VERSION)
}).strict();

export type ReleaseLedger = z.infer<typeof releaseLedgerSchema>;

export interface ReleaseLogEntry {
  at: string;
  deployment: string;
  identity: string | null;
  image_tag?: string;
  message?: string;
  notified?: { channel: "command" | "webhook" | "none"; delivered: boolean; error?: string };
  outcome: "deferred" | "failed" | "notified" | "released";
  reason?: string;
  timings?: z.infer<typeof timings>;
  version: typeof RELEASE_LOG_VERSION;
}

export interface ReleasePaths {
  directory: string;
  drainMarker: string;
  ledger: string;
  lock: string;
  log: string;
  pending: string;
}

export const resolveReleasePaths = (deployment: string, root?: string): ReleasePaths => {
  const directory = path.join(root ?? path.join(resolveSpawnfileHome(), "releases"), normalizeDeploymentName(deployment));
  return {
    directory,
    drainMarker: path.join(directory, "drain.json"),
    ledger: path.join(directory, "ledger.json"),
    lock: path.join(directory, ".lock"),
    log: path.join(directory, "log.jsonl"),
    pending: path.join(directory, "pending.json")
  };
};

export const ensureReleaseDirectory = async (paths: ReleasePaths): Promise<void> => {
  await mkdir(paths.directory, { mode: 0o700, recursive: true });
  await chmod(paths.directory, 0o700);
};

/**
 * A missing ledger means nothing has been released into this deployment yet,
 * which is a full release. A ledger that exists and cannot be read means this
 * command does not know what is running, and it must not deploy: it could not
 * write the record the next run depends on either. Unreadable is a refusal,
 * never an assumed-stale.
 */
export const readReleaseLedger = async (file: string): Promise<ReleaseLedger | null> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ReleaseError("blocked", `cannot read the release ledger ${file}: ${(error as Error).message}`);
  }
  try {
    return releaseLedgerSchema.parse(JSON.parse(source));
  } catch {
    throw new ReleaseError(
      "blocked",
      `the release ledger ${file} is not a ${RELEASE_LEDGER_VERSION} record; refusing to release against a ledger this command cannot read`
    );
  }
};

/** Same-directory temp file + rename, so a reader sees the old record or the new one. */
export const writeJsonAtomic = async (file: string, value: unknown): Promise<void> => {
  const scratch = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(scratch, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(scratch, file);
  } catch (error) {
    await rm(scratch, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const writeReleaseLedger = async (file: string, ledger: ReleaseLedger): Promise<void> => {
  await writeJsonAtomic(file, releaseLedgerSchema.parse(ledger));
};

export const appendReleaseLog = async (file: string, entry: Omit<ReleaseLogEntry, "version">): Promise<void> => {
  await appendFile(file, `${JSON.stringify({ ...entry, version: RELEASE_LOG_VERSION })}\n`, { encoding: "utf8", mode: 0o600 });
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * One release per deployment at a time. The lock file appears with its owner
 * already in it (written aside, then hard-linked into place, which fails if
 * the lock exists), so no reader can see an empty lock and call it stale. A
 * lock whose owner is gone is moved aside under a unique name first, so two
 * processes reclaiming the same stale lock cannot both win.
 */
export const acquireReleaseLock = async (
  paths: ReleasePaths,
  hooks: { afterStaleRead?: () => Promise<void> } = {}
): Promise<() => Promise<void>> => {
  const token = `${process.pid}.${randomUUID()}`;
  const staged = `${paths.lock}.${token}`;
  await writeFile(staged, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(staged, paths.lock);
        return async () => {
          const current = await readFile(paths.lock, "utf8").catch(() => "");
          if (current.includes(token)) await rm(paths.lock, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const seen = await readFile(paths.lock, "utf8").catch(() => "");
      let owner: number | null = null;
      try { owner = (JSON.parse(seen) as { pid?: number }).pid ?? null; } catch { owner = null; }
      if (owner !== null && isProcessAlive(owner)) {
        throw new ReleaseError("blocked", `another release of this deployment is running (pid ${owner})`);
      }
      await hooks.afterStaleRead?.();
      const tombstone = `${paths.lock}.stale.${token}`;
      await rename(paths.lock, tombstone).catch(() => undefined);
      const moved = await readFile(tombstone, "utf8").catch(() => null);
      if (moved !== null && moved !== seen) {
        // Another process replaced the stale lock between our read and our move: put its live lock back.
        await link(tombstone, paths.lock).catch(() => undefined);
        await rm(tombstone, { force: true });
        throw new ReleaseError("blocked", "another release of this deployment took the lock first");
      }
      await rm(tombstone, { force: true });
    }
    throw new ReleaseError("blocked", "another release of this deployment took the lock first");
  } finally {
    await rm(staged, { force: true });
  }
};
