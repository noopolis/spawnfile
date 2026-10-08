import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";

/** Thrown when a live process holds the lock (or won a race for it). */
export class PidLockBusyError extends Error {
  public readonly ownerPid: number | null;

  public constructor(ownerPid: number | null) {
    super(ownerPid === null ? "the lock was taken by another process" : `the lock is held by pid ${ownerPid}`);
    this.ownerPid = ownerPid;
    this.name = "PidLockBusyError";
  }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process (stale). EPERM: it exists but is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface PidLockHooks {
  /** Test seam: runs between reading a stale lock and moving it aside. */
  afterStaleRead?: () => Promise<void>;
}

/**
 * An exclusive lock file that names its owner from the instant it exists:
 * the content is written aside and hard-linked into place, and `link` fails
 * when the path exists, so no reader ever sees an empty lock and calls it
 * stale. A lock whose owner process is gone is moved aside under a unique
 * name and checked: if what was moved is not the stale lock that was read,
 * another process replaced it in between, and it is put back.
 *
 * Residual: pid locks cannot be made race-free for stale reclamation without
 * kernel locks. Three contenders arriving within microseconds of each other,
 * all after a crashed owner, can still overlap. Run unattended jobs through a
 * scheduler that does not overlap them.
 *
 * Release removes the lock only while it still carries this owner's token.
 */
export const acquirePidLock = async (lockPath: string, hooks: PidLockHooks = {}): Promise<() => Promise<void>> => {
  const token = `${process.pid}.${randomUUID()}`;
  const staged = `${lockPath}.${token}`;
  await writeFile(staged, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(staged, lockPath);
        return async () => {
          const current = await readFile(lockPath, "utf8").catch(() => "");
          if (current.includes(token)) await rm(lockPath, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const seen = await readFile(lockPath, "utf8").catch(() => "");
      let owner: number | null = null;
      try { owner = (JSON.parse(seen) as { pid?: number }).pid ?? null; } catch { owner = null; }
      if (owner !== null && isProcessAlive(owner)) throw new PidLockBusyError(owner);
      await hooks.afterStaleRead?.();
      const tombstone = `${lockPath}.stale.${token}`;
      await rename(lockPath, tombstone).catch(() => undefined);
      const moved = await readFile(tombstone, "utf8").catch(() => null);
      if (moved !== null && moved !== seen) {
        await link(tombstone, lockPath).catch(() => undefined);
        await rm(tombstone, { force: true });
        throw new PidLockBusyError(null);
      }
      await rm(tombstone, { force: true });
    }
    throw new PidLockBusyError(null);
  } finally {
    await rm(staged, { force: true });
  }
};
