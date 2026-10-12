import { closeSync, constants, openSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

/** A persistent, non-secret SQLite file owns the OS lock, never the directory.
 * SQLite releases it on process death. Do not unlink the file/directory: another
 * writer may already have the same inode open. Legacy empty lock dirs are safe.
 */
export const acquireTrainingGrokWritebackLock = async (profile: string): Promise<() => void> => {
  const root = `${profile}.training-writeback.lock`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root);
  if (await realpath(root) !== path.resolve(root) || !directory.isDirectory() ||
    directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) throw Error("Unsafe writeback lock");
  const file = path.join(root, "lock.sqlite");
  // Closing an independently opened fd can drop this process's POSIX locks.
  // Only open when creating; SQLite owns every fd for an existing lock file.
  // Creation and close must not yield to another acquisition in this process.
  try {
    closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const entry = await lstat(file);
  if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o600) throw Error("Unsafe writeback lock");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    return () => { database.close(); };
  } catch (error) { database.close(); throw error; }
};
