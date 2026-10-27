import { closeSync, constants, openSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const closedStartups = new WeakSet<object>();
// An unconfirmed native shutdown fences the account until this container exits.
// Keep ownership strongly reachable; GC must never silently release that fence.
const activeLeases = new Set<() => void>();
export function recordNativeStartupClosure(error: unknown, confirmed: boolean): unknown {
  if (!confirmed) return error;
  const failure = error !== null && typeof error === 'object' ? error : new Error('Native startup failed', { cause: error });
  closedStartups.add(failure);
  return failure;
}
export const nativeStartupClosureConfirmed = (error: unknown): boolean => error !== null && typeof error === 'object' && closedStartups.has(error);

/** Serializes complete native hosts on one persistent subscription account.
 * The non-secret SQLite inode is never unlinked: the kernel releases ownership
 * on process death, while cancelling a waiter leaves the active owner intact.
 */
export async function acquireNativeAccountLease(root: string, signal?: AbortSignal, maxWaitMs = 30 * 60_000): Promise<() => void> {
  signal?.throwIfAborted();
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) throw new Error('Invalid native account wait bound');
  const directory = await lstat(root);
  if (await realpath(root) !== resolve(root) || !directory.isDirectory() || directory.uid !== process.getuid?.()
    || (directory.mode & 0o777) !== 0o700) throw new Error('Unsafe native account directory');
  const file = join(root, '.training-host.sqlite');
  // Do not open/close an existing inode: that could drop another POSIX lock
  // held in this process. SQLite coordinates all existing-inode descriptors.
  try { closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid?.()
    || (entry.mode & 0o777) !== 0o600) throw new Error('Unsafe native account lease');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file);
  const deadline = performance.now() + maxWaitMs;
  try {
    database.exec('PRAGMA busy_timeout = 0');
    for (;;) {
      signal?.throwIfAborted();
      try {
        database.exec('BEGIN EXCLUSIVE');
        let closed = false;
        const close = (): void => { if (!closed) { closed = true; database.close(); activeLeases.delete(close); } };
        activeLeases.add(close);
        return close;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('Native account admission exceeded its wait bound');
        await pause(Math.min(25, remaining), undefined, { signal });
      }
    }
  } catch (error) { database.close(); throw error; }
}
