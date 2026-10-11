import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** Closed native layouts cannot carry unrelated retained bytes, even when their dates are stamped. */
export const assertDirectoryEntries = async (
  directory: string, expected: Record<string, "file" | "directory" | "symlink">
): Promise<void> => {
  const names = await readdir(directory);
  for (const name of names) {
    if (!Object.hasOwn(expected, name)) throw new Error(`Unexpected payload entry ${name}`);
    const stat = await lstat(path.join(directory, name)), kind = expected[name];
    if (!(kind === "file" ? stat.isFile() : kind === "directory" ? stat.isDirectory() : stat.isSymbolicLink())) {
      throw new Error(`Payload entry ${name} must be a ${kind}`);
    }
  }
  for (const name of Object.keys(expected)) if (!names.includes(name)) throw new Error(`Missing payload entry ${name}`);
};
