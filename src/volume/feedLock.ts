// ONE WRITER AT A TIME. Two refreshes racing are survivable (content is addressed by revision), but a
// refresh racing a garbage collection or a re-land is a reader watching entries move. The lock is a
// file created with O_EXCL in the host state directory, carrying the holder's pid and a random token.
//
// A crashed holder leaves the file behind, so a holder whose pid is gone on this host is stale. Reclaiming
// it is serialized by a second O_EXCL guard file that also names its holder's pid. A guard is cleared only
// when its own holder is provably dead, never by age: an age rule lets a live but slow reclaimer lose its
// guard and then delete the lock a second reclaimer just took. Under the guard the lock is re-read and
// removed only if it is still the exact stale bytes that were judged.
//
// A lock or guard that cannot be read as an owner (a crash between create and write) is not contention:
// it is reported, with the one command that clears it, instead of reading as "busy" forever.
//
// Every job that must not interleave with a swap (a release that recreates containers, for example)
// takes this same lock through `acquireFeedLock`.

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import { feedError } from "./feedLayout.js";

export const FEED_LOCK_FILE = "lock";

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

/** An owner record, allowing a live writer the moment between creating the file and writing it. */
const readOwnerText = (file: string): string | null => {
  const first = readOrNull(file);
  if (first === null || parseOwner(first) !== null) return first;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return readOrNull(file);
};

const parseOwner = (text: string | null): LockOwner | null => {
  try { const value = JSON.parse(text ?? "") as LockOwner; return Number.isInteger(value.pid) && typeof value.host === "string" ? value : null; }
  catch { return null; }
};

/** Stale only when provably dead: same host and no such pid. An unreadable lock is a live one. */
const isStale = (text: string | null): boolean => {
  const owner = parseOwner(text);
  return owner !== null && owner.host === hostname() && !processAlive(owner.pid);
};

const ownerContent = (): string => `${JSON.stringify({ at: new Date().toISOString(), host: hostname(), pid: process.pid, token: randomUUID() })}\n`;

const malformed = (file: string): never => {
  throw feedError(`the feed lock ${file} does not name a holder (a writer crashed while taking it); if no refresh is running, clear it with: rm -- ${file}`);
};

const reclaim = (file: string, judged: string): boolean => {
  const guard = `${file}.reclaim`, mine = ownerContent();
  if (!createExclusive(guard, mine)) {
    const held = readOwnerText(guard);
    if (held === null) return false;
    if (parseOwner(held) === null) malformed(guard);
    if (!isStale(held)) return false;
    // Clear the dead guard only if it is still the bytes judged dead, then compete for it again.
    if (readOrNull(guard) !== held) return false;
    rmSync(guard, { force: true });
    if (!createExclusive(guard, mine)) return false;
  }
  try {
    if (readOrNull(file) !== judged) return false;
    unlinkSync(file);
    return true;
  } finally { if (readOrNull(guard) === mine) rmSync(guard, { force: true }); }
};

/** Null when another live writer holds the lock. */
export const acquireFeedLock = (stateDir: string): FeedLock | null => {
  mkdirSync(stateDir, { mode: 0o700, recursive: true });
  const file = path.join(stateDir, FEED_LOCK_FILE);
  const content = ownerContent();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createExclusive(file, content)) {
      return {
        path: file,
        release: () => { if (readOrNull(file) === content) rmSync(file, { force: true }); }
      };
    }
    const held = readOwnerText(file);
    if (held === null) continue;
    if (parseOwner(held) === null) malformed(file);
    if (!isStale(held) || !reclaim(file, held)) return null;
  }
  return null;
};
