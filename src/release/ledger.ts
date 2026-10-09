import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { resolveSpawnfileHome } from "../auth/index.js";
import { acquirePidLock, normalizeDeploymentName, PidLockBusyError, type PidLockHooks } from "../deployment/index.js";

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
  /** Present from just before a post-deploy command runs until the ledger records its success. */
  postDeploy: string;
}

export const resolveReleasePaths = (deployment: string, root?: string): ReleasePaths => {
  const directory = path.join(root ?? path.join(resolveSpawnfileHome(), "releases"), normalizeDeploymentName(deployment));
  return {
    directory,
    drainMarker: path.join(directory, "drain.json"),
    ledger: path.join(directory, "ledger.json"),
    lock: path.join(directory, ".lock"),
    log: path.join(directory, "log.jsonl"),
    pending: path.join(directory, "pending.json"),
    postDeploy: path.join(directory, "post-deploy.json")
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

/** Anything but "definitely absent" counts as present: an unknown marker never reads as done. */
export const postDeployPending = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
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

/** One release per deployment at a time; see `acquirePidLock` for the guarantees and the residual. */
export const acquireReleaseLock = async (
  paths: ReleasePaths,
  hooks: PidLockHooks = {}
): Promise<() => Promise<void>> => {
  try {
    return await acquirePidLock(paths.lock, hooks);
  } catch (error) {
    if (error instanceof PidLockBusyError) {
      throw new ReleaseError("blocked", error.ownerPid === null
        ? "another release of this deployment took the lock first"
        : `another release of this deployment is running (pid ${error.ownerPid})`);
    }
    throw error;
  }
};
