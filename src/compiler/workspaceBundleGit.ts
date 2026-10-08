import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

const run = promisify(execFile);
const MAX_BUFFER = 268_435_456;
// Never take git's optional index lock: a compile reads the repository, it does not maintain it.
// Never honour replacement refs: the cache key names object ids, so their bytes must be the objects'.
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" });

const git = async (cwd: string, args: string[]): Promise<Buffer> => {
  try {
    const { stdout } = await run("git", args, { cwd, encoding: "buffer", env: gitEnv(), maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString("utf8").trim();
    throw new SpawnfileError("validation_error", `Workspace bundle git query failed in ${cwd}: git ${args[0]}${stderr ? `: ${stderr}` : ""}`);
  }
};

const records = (output: Buffer): string[] => output.toString("utf8").split("\0").filter(Boolean);

export interface GitTreeEntry {
  mode: number;
  objectId: string;
  path: string;
  type: string;
}

export interface GitIndexEntry {
  mode: number;
  objectId: string;
  path: string;
  stage: number;
}

export interface GitLocation {
  indexPath: string;
  prefix: string;
  topLevel: string;
}

/** The repository top level, this directory's path prefix inside it ("" at the top), and the index file. */
export const resolveGitLocation = async (directory: string): Promise<GitLocation> => {
  const [topLevel, prefix = "", indexPath = ""] = (await git(directory, ["rev-parse", "--show-toplevel", "--show-prefix", "--git-path", "index"])).toString("utf8").split("\n");
  if (!topLevel || !indexPath) throw new SpawnfileError("validation_error", `Workspace bundle root is not inside a git work tree: ${directory}`);
  return { indexPath: path.resolve(directory, indexPath), prefix, topLevel };
};

const indexStamp = async (location: GitLocation): Promise<string> => {
  const index = await stat(location.indexPath).catch(() => undefined);
  return JSON.stringify([index?.ino, index?.size, index?.mtimeMs]);
};

/**
 * Runs `read` against one consistent index: the index file must be identical
 * before and after, else a concurrent `git add` could pair an old index
 * listing with a new status. Retries a few times, then fails.
 */
export const readStableSnapshot = async <T>(location: GitLocation, read: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await indexStamp(location);
    const value = await read();
    if (before === await indexStamp(location)) return value;
  }
  throw new SpawnfileError("validation_error", `Workspace bundle inputs kept changing while they were read: ${location.topLevel}`);
};

/** Committed tree under `directory`: blob ids and modes from the tree objects alone, no blob or file reads. */
export const listCommittedTree = async (directory: string, commit = "HEAD"): Promise<GitTreeEntry[]> =>
  records(await git(directory, ["ls-tree", "-r", "-z", commit, "--", "."])).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    return { mode: Number.parseInt(mode!, 8), objectId: objectId!, path: record.slice(tab + 1), type: type! };
  });

/** Index entries under `directory` (paths relative to it). */
export const listIndex = async (directory: string): Promise<GitIndexEntry[]> =>
  records(await git(directory, ["ls-files", "-s", "-z", "--", "."])).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, objectId, stage] = record.slice(0, tab).split(" ");
    return { mode: Number.parseInt(mode!, 8), objectId: objectId!, path: record.slice(tab + 1), stage: Number(stage) };
  });

export interface GitStatusEntry {
  index: string;
  path: string;
  worktree: string;
}

/**
 * `git status` under `directory`, paths relative to the repository top level
 * (strip the location prefix). Untracked, not-ignored files appear
 * individually as `??`; a nested repository appears once with a trailing "/".
 * Ignored paths never appear.
 */
export const readStatus = async (directory: string): Promise<GitStatusEntry[]> =>
  records(await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."])).map((record) => (
    { index: record[0]!, path: record.slice(3), worktree: record[1]! }
  ));

/** The HEAD commit id, or "" when the repository has none. */
export const resolveHead = async (directory: string): Promise<string> =>
  git(directory, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]).then((output) => output.toString("utf8").trim(), () => "");

/**
 * The commit `git status` compared against and every changed path under
 * `directory` (repository-relative), from one porcelain v2 run. Pairing the
 * two in one process means a concurrent commit can never split them.
 */
export const readStatusAgainstHead = async (directory: string): Promise<{ changed: string[]; head: string }> => {
  let head = "";
  const changed: string[] = [];
  for (const record of records(await git(directory, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--no-renames", "--", "."]))) {
    if (record.startsWith("# branch.oid ")) { const oid = record.slice(13); head = /^[a-f0-9]{40,64}$/u.test(oid) ? oid : ""; continue; }
    if (record.startsWith("#")) continue;
    const fields = record.split(" "), skip = record[0] === "1" ? 8 : record[0] === "u" ? 10 : 1;
    changed.push(fields.slice(skip).join(" "));
  }
  return { changed, head };
};

/**
 * Streams blob contents for `objectIds`, in order, through `onBlob`. One
 * `git cat-file --batch` process serves the whole tree; content never touches
 * the work tree, so the result is a pure function of the committed objects.
 */
export const streamBlobs = async (
  directory: string,
  objectIds: string[],
  handlers: { begin: (index: number, size: number) => Promise<void>; data: (chunk: Buffer) => Promise<void>; end: () => Promise<void> }
): Promise<void> => {
  const child = spawn("git", ["cat-file", "--batch"], { cwd: directory, env: gitEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdin.on("error", () => undefined);
  child.stdin.end(objectIds.map((id) => `${id}\n`).join(""));
  let index = 0, remaining = -1, trailer = false, header = Buffer.alloc(0);
  try {
    for await (const raw of child.stdout as AsyncIterable<Buffer>) {
      let chunk = raw;
      while (chunk.length > 0) {
        if (trailer) {
          if (chunk[0] !== 0x0a) throw new SpawnfileError("validation_error", "Workspace bundle blob stream is malformed");
          chunk = chunk.subarray(1); trailer = false; await handlers.end(); index += 1; continue;
        }
        if (remaining < 0) {
          const newline = chunk.indexOf(0x0a);
          if (newline < 0) { header = Buffer.concat([header, chunk]); break; }
          const line = Buffer.concat([header, chunk.subarray(0, newline)]).toString("utf8"); header = Buffer.alloc(0);
          chunk = chunk.subarray(newline + 1);
          const [objectId, type, size] = line.split(" ");
          if (index >= objectIds.length || objectId !== objectIds[index] || type !== "blob" || !/^\d+$/u.test(size ?? "")) {
            throw new SpawnfileError("validation_error", `Workspace bundle blob ${objectIds[index] ?? "?"} is not readable: ${line}`);
          }
          remaining = Number(size); await handlers.begin(index, remaining);
        }
        const take = Math.min(remaining, chunk.length);
        if (take > 0) await handlers.data(chunk.subarray(0, take));
        chunk = chunk.subarray(take); remaining -= take;
        if (remaining === 0) { remaining = -1; trailer = true; }
      }
    }
  } catch (error) {
    child.kill();
    await exited.catch(() => undefined);
    throw error;
  }
  const code = await exited;
  if (code !== 0 || index !== objectIds.length || remaining !== -1 || trailer) {
    throw new SpawnfileError("validation_error", `Workspace bundle blob stream ended early${stderr ? `: ${stderr.trim()}` : ""}`);
  }
};
