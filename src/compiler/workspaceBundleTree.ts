import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../shared/index.js";

import type { BundleFileEntry, BundleFilesInput } from "./workspaceBundleFiles.js";
import { normalizeBundleMode, WORKSPACE_BUNDLE_MAX_BYTES, WORKSPACE_BUNDLE_MAX_ENTRIES } from "./workspaceBundleTar.js";

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};

export interface WalkOptions {
  /** Root-relative paths left out of the archive entirely. */
  skip?: (relativePath: string) => boolean;
  /** Symlinks for which this returns true are dropped; any other symlink fails the build. */
  dropSymlink?: (relativePath: string) => boolean;
}

/**
 * Every regular file under `directory`, hashed, as an archive input set.
 * Built output (installed dependencies, generated files) has no git
 * identity, so each file is content-addressed. Symlinks, devices and sockets
 * cannot be archived safely and fail unless explicitly dropped. Entry and byte
 * budgets are enforced while walking, before the archive is written.
 */
export const walkBuiltTree = async (directory: string, options: WalkOptions = {}): Promise<BundleFilesInput> => {
  const root = await lstat(directory);
  if (!root.isDirectory()) fail(`Built workspace bundle output root was replaced by something other than a directory: ${directory}`);
  const entries: BundleFileEntry[] = [];
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (options.skip?.(child)) continue;
      const info = await lstat(path.join(directory, child));
      if (info.isDirectory()) { await visit(child); continue; }
      if (info.isSymbolicLink()) {
        if (options.dropSymlink?.(child)) continue;
        fail(`Built workspace bundle output contains a symlink: ${child}`);
      }
      if (!info.isFile()) fail(`Built workspace bundle output contains an unsupported file type: ${child}`);
      if (child.includes("\\")) fail(`Built workspace bundle output path cannot be archived safely: ${child}`);
      bytes += info.size;
      if (bytes > WORKSPACE_BUNDLE_MAX_BYTES) fail("Workspace bundle exceeds the maximum archive size");
      if (entries.length >= WORKSPACE_BUNDLE_MAX_ENTRIES) fail("Workspace bundle exceeds the maximum entry count");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path.join(directory, child))) hash.update(chunk as Buffer);
      entries.push({ identity: `sha256:${hash.digest("hex")}`, mode: normalizeBundleMode(info.mode), path: child });
    }
  };
  await visit("");
  if (entries.length === 0) fail(`Built workspace bundle output is empty: ${directory}`);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { directory, entries, mode: "dev" };
};
