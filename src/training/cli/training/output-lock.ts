import { lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** SQLite owns the process lock: abrupt death releases it without stale PID heuristics. */
export async function reserveOutput(root: string): Promise<() => void> {
  const path = join(root,'.invocation-lock.sqlite');
  try {if ((await lstat(path)).isSymbolicLink()) throw new Error('Output lock cannot be a symlink');}
  catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  try {
    await chmod(path,0o600);
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    database.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY)');
  } catch(error) {
    database.close();
    const code = (error as { errcode?: number }).errcode;
    throw new Error(code === 5 || code === 6 ? 'Output is reserved by another command'
      : `Output lock unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  // Closing rolls back the uncommitted lock transaction and releases its file lock.
  return () => database.close();
}
