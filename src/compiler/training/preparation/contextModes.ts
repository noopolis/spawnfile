import { chmod, lstat, readdir, utimes } from "node:fs/promises";
import path from "node:path";

/** Fixed staged timestamp: deterministic context bytes, and still valid in ZIP-based Python builds. */
export const TRAINING_CONTEXT_MTIME = new Date("2000-01-01T00:00:00Z");

/** Executables the recipe previously forced to 0555 before its recursive closure. */
const EXACT_MODES: Readonly<Record<string, number>> = { grok: 0o555, train: 0o555 };

/**
 * `chmod a+rX` closure: every directory gains 0555; every other entry gains 0444,
 * plus 0111 when any execute bit is already present. Symlinks are never staged.
 */
export const readableClosure = (mode: number, directory: boolean): number =>
  directory ? (mode & 0o7777) | 0o555 : (mode & 0o7777) | 0o444 | ((mode & 0o111) !== 0 ? 0o111 : 0);

/**
 * Fix staged build-context modes and times so COPY produces exactly the modes the
 * former in-image `chmod 0555 grok train && chmod -R a+rX /opt/training` produced.
 */
export async function normalizeTrainingContext(staging: string): Promise<void> {
  const visit = async (entry: string, relative: string): Promise<void> => {
    const stat = await lstat(entry);
    if (stat.isSymbolicLink()) throw Error("Training build context must not contain symlinks");
    if (stat.isDirectory()) {
      for (const name of (await readdir(entry)).sort()) await visit(path.join(entry, name), path.posix.join(relative, name));
      if (relative) await chmod(entry, readableClosure(stat.mode, true));
    } else {
      await chmod(entry, EXACT_MODES[relative] ?? readableClosure(stat.mode, false));
    }
    if (relative) await utimes(entry, TRAINING_CONTEXT_MTIME, TRAINING_CONTEXT_MTIME);
  };
  await visit(staging, "");
}
