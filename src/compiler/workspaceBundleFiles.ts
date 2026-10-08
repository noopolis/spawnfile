import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../shared/index.js";

import {
  listCommittedTree,
  listIndex,
  readStableSnapshot,
  readStatus,
  readStatusAgainstHead,
  resolveGitLocation,
  streamBlobs,
  type GitStatusEntry
} from "./workspaceBundleGit.js";
import {
  BundleTarWriter,
  normalizeBundleMode,
  WORKSPACE_BUNDLE_MAX_BYTES,
  WORKSPACE_BUNDLE_MAX_ENTRIES,
  type BundleFileMode,
  type BundleTarSummary
} from "./workspaceBundleTar.js";

export type BundleIdentityMode = "dev" | "release";

/** One archived file. `identity` is a git object id (`git:`, content read from the object store) or a content digest (`sha256:`, read from disk). */
export interface BundleFileEntry {
  identity: string;
  mode: BundleFileMode;
  objectId?: string;
  path: string;
}

export interface BundleFilesInput {
  directory: string;
  entries: BundleFileEntry[];
  mode: BundleIdentityMode;
}

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};

const SYMLINK = 0o120000, GITLINK = 0o160000;

const escapeRegExp = (value: string): string => value.replace(/[.+^${}()|[\]\\]/gu, "\\$&");

/**
 * Exclude patterns match the path relative to the bundle root: `*` and `?`
 * stay inside one segment, `**` crosses segments, and a pattern that matches
 * a directory excludes everything beneath it.
 */
export const compileExcludePatterns = (patterns: readonly string[] = []): ((relativePath: string) => boolean) => {
  const expressions = patterns.map((pattern) => {
    const trimmed = pattern.replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (!trimmed || trimmed.startsWith("/") || trimmed.split("/").some((segment) => segment === ".." || segment === ".")) {
      fail(`Workspace bundle exclude pattern must be a relative path glob: ${pattern}`);
    }
    let source = "";
    for (let index = 0; index < trimmed.length;) {
      if (trimmed.startsWith("**/", index)) { source += "(?:.*/)?"; index += 3; }
      else if (trimmed.startsWith("**", index)) { source += ".*"; index += 2; }
      else if (trimmed[index] === "*") { source += "[^/]*"; index += 1; }
      else if (trimmed[index] === "?") { source += "[^/]"; index += 1; }
      else { source += escapeRegExp(trimmed[index]!); index += 1; }
    }
    return new RegExp(`^${source}$`, "u");
  });
  return (relativePath) => {
    if (expressions.length === 0) return false;
    const segments = relativePath.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const candidate = segments.slice(0, length).join("/");
      if (expressions.some((expression) => expression.test(candidate))) return true;
    }
    return false;
  };
};

const validEntryPath = (relativePath: string): string => {
  if (!relativePath || relativePath.includes("\\") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`Workspace bundle input path cannot be archived safely: ${relativePath}`);
  }
  return relativePath;
};

const refuseLinks = (relativePath: string, mode: number): void => {
  if (mode === SYMLINK) fail(`Workspace bundle input is a symlink; exclude it or replace it with a file: ${relativePath}`);
  if (mode === GITLINK) fail(`Workspace bundle input is a git submodule; exclude it or declare it as its own resource: ${relativePath}`);
};

const relativeTo = (status: GitStatusEntry[], prefix: string): GitStatusEntry[] =>
  status.map((entry) => ({ ...entry, path: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path }));

const sortEntries = (entries: BundleFileEntry[]): BundleFileEntry[] =>
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

export const resolveBundleRoot = async (directory: string): Promise<string> => {
  const info = await lstat(directory).catch(() => fail(`Workspace bundle root does not exist: ${directory}`));
  if (!info.isDirectory()) fail(`Workspace bundle root must be a real directory, not a file or symlink: ${directory}`);
  return realpath(directory);
};

/**
 * Release identity: the root must be clean against HEAD (ignoring excluded
 * paths), and the identity is the committed tree's blob ids and modes. No
 * input file is read.
 */
export const resolveReleaseFiles = async (directory: string, exclude: readonly string[] = []): Promise<BundleFilesInput> => {
  const excluded = compileExcludePatterns(exclude);
  const [{ prefix }, status] = await Promise.all([resolveGitLocation(directory), readStatusAgainstHead(directory)]);
  if (!status.head) fail(`Release workspace bundle requires a commit; the repository has none: ${directory}`);
  const dirty = status.changed.map((changed) => changed.startsWith(prefix) ? changed.slice(prefix.length) : changed).filter((changed) => !excluded(changed));
  if (dirty.length > 0) {
    fail(`Release workspace bundle requires a clean commit; ${dirty.length} uncommitted change(s) under ${directory}, first: ${dirty[0]!}`);
  }
  // The tree of exactly the commit status verified clean against; bytes come from its objects, so later edits cannot leak in.
  const tree = await listCommittedTree(directory, status.head);
  const entries: BundleFileEntry[] = [];
  for (const entry of tree) {
    if (excluded(entry.path)) continue;
    refuseLinks(entry.path, entry.mode);
    if (entry.type !== "blob") fail(`Workspace bundle input has unsupported git type ${entry.type}: ${entry.path}`);
    entries.push({ identity: `git:${entry.objectId}`, mode: normalizeBundleMode(entry.mode), objectId: entry.objectId, path: validEntryPath(entry.path) });
  }
  return { directory, entries: sortEntries(entries), mode: "release" };
};

const HASH_CONCURRENCY = 8;

const hashFile = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
};

/**
 * Dev identity: the working tree as it is now. Files git reports as unchanged
 * keep their index blob id; modified and untracked (not ignored) files are
 * hashed from disk, so an uncommitted edit or a new file always moves the key.
 */
export const resolveDevFiles = async (directory: string, exclude: readonly string[] = []): Promise<BundleFilesInput> => {
  const excluded = compileExcludePatterns(exclude), location = await resolveGitLocation(directory), { prefix } = location;
  const [index, rawStatus] = await readStableSnapshot(location, () => Promise.all([listIndex(directory), readStatus(directory)]));
  const status = relativeTo(rawStatus, prefix);
  const untracked = status.filter((entry) => entry.index === "?").map((entry) => entry.path);
  const changed = new Set(status.filter((entry) => entry.worktree !== " " && entry.worktree !== "?").map((entry) => entry.path));
  const conflicted = new Set(index.filter((entry) => entry.stage !== 0).map((entry) => entry.path));
  const entries = new Map<string, BundleFileEntry>(), toHash: string[] = [];
  for (const entry of index) {
    if (excluded(entry.path) || entries.has(entry.path)) continue;
    if (changed.has(entry.path) || conflicted.has(entry.path)) { toHash.push(entry.path); continue; }
    refuseLinks(entry.path, entry.mode);
    entries.set(entry.path, { identity: `git:${entry.objectId}`, mode: normalizeBundleMode(entry.mode), objectId: entry.objectId, path: validEntryPath(entry.path) });
  }
  for (const relativePath of untracked) {
    if (excluded(relativePath.replace(/\/$/u, ""))) continue;
    if (relativePath.endsWith("/")) fail(`Workspace bundle input contains a nested git repository; exclude it: ${relativePath}`);
    toHash.push(relativePath);
  }
  const pending = [...new Set(toHash)];
  if (entries.size + pending.length > WORKSPACE_BUNDLE_MAX_ENTRIES) fail("Workspace bundle exceeds the maximum entry count");
  let hashedBytes = 0;
  // Bounded: at most HASH_CONCURRENCY files open, and the byte budget is spent before a file is read.
  const hashNext = async (): Promise<void> => {
    for (let relativePath = pending.pop(); relativePath !== undefined; relativePath = pending.pop()) {
      const filePath = path.join(directory, relativePath);
      const info = await lstat(filePath).catch(() => undefined);
      if (!info) continue; // deleted in the work tree: not an input any more
      if (info.isSymbolicLink()) refuseLinks(relativePath, SYMLINK);
      if (!info.isFile()) fail(`Workspace bundle input is not a regular file: ${relativePath}`);
      hashedBytes += info.size;
      if (hashedBytes > WORKSPACE_BUNDLE_MAX_BYTES) fail("Workspace bundle exceeds the maximum archive size");
      entries.set(relativePath, { identity: await hashFile(filePath), mode: normalizeBundleMode(info.mode), path: validEntryPath(relativePath) });
    }
  };
  await Promise.all(Array.from({ length: HASH_CONCURRENCY }, hashNext));
  return { directory, entries: sortEntries([...entries.values()]), mode: "dev" };
};

/**
 * Writes the archive for a resolved input set. Every `git:` entry is read from
 * the object store, so its bytes are exactly the blob its identity names;
 * every `sha256:` entry is read from disk and re-checked against its digest.
 * The archive is therefore a pure function of the cache key.
 */
export const writeBundleFiles = async (input: BundleFilesInput, outputPath: string): Promise<BundleTarSummary> => {
  const writer = await BundleTarWriter.create(outputPath);
  const objects = input.entries.filter((entry) => entry.objectId !== undefined);
  const disk = input.entries.filter((entry) => entry.objectId === undefined);
  let next = 0;
  const writeDiskBefore = async (limit?: string): Promise<void> => {
    for (; next < disk.length && (limit === undefined || disk[next]!.path < limit); next += 1) {
      const entry = disk[next]!, bytes = await readFile(path.join(input.directory, entry.path));
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.identity) {
        fail(`Workspace bundle input changed while the bundle was built: ${entry.path}`);
      }
      await writer.begin(entry.path, bytes.length, entry.mode);
      await writer.data(bytes);
      await writer.end();
    }
  };
  try {
    if (objects.length > 0) {
      await streamBlobs(input.directory, objects.map((entry) => entry.objectId!), {
        begin: async (index, size) => {
          const entry = objects[index]!;
          await writeDiskBefore(entry.path);
          await writer.begin(entry.path, size, entry.mode);
        },
        data: (chunk) => writer.data(chunk),
        end: () => writer.end()
      });
    }
    await writeDiskBefore();
    return await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }
};
