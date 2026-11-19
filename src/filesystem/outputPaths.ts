import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
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

const refuseDirectory = (directory: string): never => {
  throw new SpawnfileError("validation_error", `Output directory must be a real directory: ${directory}`);
};

/** Descendants of an output root must be real directories, never links. */
const assertRealDirectory = async (directory: string): Promise<void> => {
  const entry = await readEntry(directory);
  if (entry && !entry.isDirectory()) refuseDirectory(directory);
};

/**
 * The operator-selected output root may be missing, a directory, or a link to
 * an existing directory. Anything else, including a dangling link, is refused.
 */
export const assertOutputDirectory = async (directory: string): Promise<void> => {
  const entry = await readEntry(directory);
  if (!entry || entry.isDirectory()) return;
  if (!entry.isSymbolicLink()) refuseDirectory(directory);
  const target = await stat(directory).catch(() => undefined);
  if (!target?.isDirectory()) refuseDirectory(directory);
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
    await assertRealDirectory(path.join(root, relative));
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

const MAX_STAGED_FILE_BYTES = 1024 * 1024;

const refuseStagedFile = (filename: string, reason: string): never => {
  throw new SpawnfileError("compile_error", `Staged file ${JSON.stringify(filename)} ${reason}`);
};

/**
 * Reads expected files from a private staging directory. Every directory
 * between the staging root and the file must be real, and the file must be a
 * single-link regular file that is still the same entry when opened.
 */
export const readStagedRegularFiles = async (
  directory: string, paths: readonly string[]
): Promise<string[]> => {
  const root = path.resolve(directory);
  if (!(await stat(root)).isDirectory()) refuseDirectory(root);
  return Promise.all(paths.map(async (filename) => {
    assertOutputRelativePath(filename);
    const segments = filename.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = await readEntry(path.join(root, ...segments.slice(0, index)));
      if (!parent) return refuseStagedFile(filename, "was not produced");
      if (!parent.isDirectory()) refuseStagedFile(filename, "is not inside real directories");
    }
    const target = path.join(root, ...segments);
    const entry = await readEntry(target);
    if (!entry) return refuseStagedFile(filename, "was not produced");
    if (!entry.isFile() || entry.nlink !== 1) refuseStagedFile(filename, "is not a regular file with one link");
    if (entry.size > MAX_STAGED_FILE_BYTES) refuseStagedFile(filename, "is too large");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.ino !== entry.ino || opened.dev !== entry.dev || !opened.isFile()) {
        refuseStagedFile(filename, "changed while it was read");
      }
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }));
};
