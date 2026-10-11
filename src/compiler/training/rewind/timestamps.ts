import { lstat, lutimes, readdir, utimes } from "node:fs/promises";
import path from "node:path";
import { compareInstants } from "./instant.js";

/** Round down to milliseconds so filesystem precision cannot put a stamp after the instant. */
export const stampTree = async (root: string, instant: string, at: string): Promise<void> => {
  const stamp = new Date(compareInstants(instant, at) > 0 ? at : instant);
  const visit = async (file: string): Promise<void> => {
    const stats = await lstat(file);
    if (stats.isDirectory()) for (const name of await readdir(file)) await visit(path.join(file, name));
    await (stats.isSymbolicLink() ? lutimes : utimes)(file, stamp, stamp);
  };
  await visit(root);
};

/** Disk verification reads may update atime. Restore access time without changing verified mtimes. */
export const restoreAccessTimes = async (root: string, at: string): Promise<void> => {
  const visit = async (file: string): Promise<void> => {
    const stats = await lstat(file);
    if (stats.isDirectory()) for (const name of await readdir(file)) await visit(path.join(file, name));
    await (stats.isSymbolicLink() ? lutimes : utimes)(file,
      new Date(Math.min(stats.mtimeMs, Date.parse(at))), new Date(stats.mtimeMs));
  };
  await visit(root);
};
