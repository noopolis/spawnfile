import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../shared/errors.js";
import { assertPortableRelativePath, toPosixPath } from "./paths.js";

export const assertOutputRelativePath = (value: string): void => {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)
    || /^[a-z]:/iu.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new SpawnfileError("validation_error", `Invalid emitted file path ${JSON.stringify(value)}: expected a canonical relative file path`);
  }
  assertPortableRelativePath(value);
};

const readEntry = async (filename: string): Promise<Stats | undefined> => {
  try {
    return await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const assertOutputDirectory = async (directory: string): Promise<void> => {
  const entry = await readEntry(directory);
  if (entry && !entry.isDirectory()) {
    throw new SpawnfileError("validation_error", `Output directory must be a real directory: ${directory}`);
  }
};

/** Checks the complete batch and resolves destinations before the caller writes it. */
export const resolveOutputFilePaths = async (
  directory: string, paths: readonly string[], relativeDirectory?: string
): Promise<string[]> => {
  const prefix = relativeDirectory === undefined ? undefined : toPosixPath(relativeDirectory);
  if (prefix !== undefined) assertOutputRelativePath(prefix);
  const root = path.resolve(directory);
  const parts = paths.map((filename) => {
    assertOutputRelativePath(filename);
    return prefix === undefined ? filename : `${prefix}/${filename}`;
  });
  const filenames = new Set(parts);
  if (filenames.size !== parts.length) {
    throw new SpawnfileError("validation_error", "Emitted file paths must be unique within a batch");
  }

  const directories = new Set<string>();
  for (const filename of parts) {
    let parent = path.posix.dirname(filename);
    while (parent !== ".") {
      if (filenames.has(parent)) {
        throw new SpawnfileError("validation_error", `Emitted file is also a directory: ${parent}`);
      }
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }

  await assertOutputDirectory(root);
  // Check each containing directory before inspecting its children.
  for (const relative of [...directories].sort()) {
    await assertOutputDirectory(path.join(root, relative));
  }
  const targets = parts.map((relative) => path.join(root, relative));
  await Promise.all(targets.map(async (target) => {
    const entry = await readEntry(target);
    if (entry && (!entry.isFile() || entry.nlink !== 1)) {
      throw new SpawnfileError("validation_error", `Emitted output must be a regular file with one link: ${target}`);
    }
  }));
  return targets;
};
