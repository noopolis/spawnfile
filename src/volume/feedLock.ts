// ONE WRITER AT A TIME. Two refreshes racing are survivable (content is addressed by revision), but a
// refresh racing a garbage collection or a re-land is a reader watching entries move. The lock is a
// file created with O_EXCL in the host state directory, carrying the holder's pid and a random token.
//
// A crashed holder leaves the file behind, so a holder whose pid is gone on this host is stale. Reclaiming
// it is itself serialized by a second O_EXCL file: without that, two reclaimers that both judged the old
// lock stale could each delete it, and the second would delete the FIRST reclaimer's fresh lock. Under the
// reclaim guard the lock is re-read and removed only if it is still the exact stale bytes that were judged.
//
// Every job that must not interleave with a swap (a release that recreates containers, for example)
// takes this same lock through `acquireFeedLock`.

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export const FEED_LOCK_FILE = "lock";
/** A reclaim takes milliseconds; a guard file older than this was left by a reclaimer that crashed. */
export const RECLAIM_GUARD_STALE_MS = 30_000;

export interface FeedLock {
  path: string;
  release: () => void;
}

interface LockOwner { host: string; pid: number; token: string }

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

const createExclusive = (file: string, content: string): boolean => {
  let fd;
  try { fd = openSync(file, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { writeSync(fd, content); } finally { closeSync(fd); }
  return true;
};

const readOrNull = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };

const parseOwner = (text: string | null): LockOwner | null => {
  try { const value = JSON.parse(text ?? "") as LockOwner; return Number.isInteger(value.pid) && typeof value.host === "string" ? value : null; }
  catch { return null; }
};

/** Stale only when provably dead: same host and no such pid. An unreadable lock is a live one. */
const isStale = (text: string | null): boolean => {
  const owner = parseOwner(text);
  return owner !== null && owner.host === hostname() && !processAlive(owner.pid);
};

const reclaim = (file: string, judged: string): boolean => {
  const guard = `${file}.reclaim`;
  if (!createExclusive(guard, String(process.pid))) {
    let age = 0;
    try { age = Date.now() - statSync(guard).mtimeMs; } catch { return false; }
    if (age < RECLAIM_GUARD_STALE_MS) return false;
    rmSync(guard, { force: true });
    if (!createExclusive(guard, String(process.pid))) return false;
  }
  try {
    if (readOrNull(file) !== judged) return false;
    unlinkSync(file);
    return true;
  } finally { rmSync(guard, { force: true }); }
};

/** Null when another live writer holds the lock. */
export const acquireFeedLock = (stateDir: string): FeedLock | null => {
  mkdirSync(stateDir, { mode: 0o700, recursive: true });
  const file = path.join(stateDir, FEED_LOCK_FILE);
  const content = `${JSON.stringify({ at: new Date().toISOString(), host: hostname(), pid: process.pid, token: randomUUID() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createExclusive(file, content)) {
      return {
        path: file,
        release: () => { if (readOrNull(file) === content) rmSync(file, { force: true }); }
      };
    }
    const held = readOrNull(file);
    if (!isStale(held) || !reclaim(file, held as string)) return null;
  }
  return null;
};
