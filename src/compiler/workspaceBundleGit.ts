import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

const run = promisify(execFile);
const MAX_BUFFER = 268_435_456;
// Never take git's optional index lock: a compile reads the repository, it does not maintain it.
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0" });

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

/** The repository top level and this directory's path prefix inside it ("" at the top). */
export const resolveGitLocation = async (directory: string): Promise<{ prefix: string; topLevel: string }> => {
  const [topLevel, prefix = ""] = (await git(directory, ["rev-parse", "--show-toplevel", "--show-prefix"])).toString("utf8").split("\n");
  if (!topLevel) throw new SpawnfileError("validation_error", `Workspace bundle root is not inside a git work tree: ${directory}`);
  return { prefix, topLevel };
};

/** Committed tree under `directory`: blob ids and modes from the tree objects alone, no blob or file reads. */
export const listCommittedTree = async (directory: string): Promise<GitTreeEntry[]> =>
  records(await git(directory, ["ls-tree", "-r", "-z", "HEAD", "--", "."])).map((record) => {
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
