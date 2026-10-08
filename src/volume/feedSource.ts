// Where a fed volume's content comes from, and how it is copied into a private staging directory.
//
// A revision is CONTENT-addressed: a commit that does not change the fed paths, or a directory whose
// bytes did not move, resolves to the same revision and lands nothing.

import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

import { feedError } from "./feedLayout.js";
import { sha256Hex } from "./feedManifest.js";

export type FeedSourceSpec =
  | { fetch: boolean; kind: "git"; paths?: string[]; ref: string; repo: string }
  | { directory: string; kind: "directory" };

export type FeedProvenance =
  | { commit: string; kind: "git"; paths: string[] | null; ref: string }
  | { kind: "directory" };

export interface ResolvedFeedSource {
  provenance: FeedProvenance;
  revision: string;
}

export type FeedExec = (command: string, args: string[], options?: { cwd?: string; input?: Buffer }) => Buffer;

/**
 * Stdin is closed unless input is given: tar once exited 0 having extracted nothing because its archive
 * was silently discarded, so `stageFeedSource` also refuses an empty extraction.
 */
export const hostExec: FeedExec = (command, args, options = {}) => execFileSync(command, args, {
  cwd: options.cwd,
  input: options.input,
  maxBuffer: 1024 * 1024 * 1024,
  stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
});

const gitOut = (exec: FeedExec, repo: string, args: string[]): string => exec("git", ["-C", repo, ...args]).toString().trim();

/** Sorted (path, kind, executable bit, bytes) of a directory tree; symlinks by their target text. */
export const digestDirectory = (root: string): string => {
  const lines: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name), key = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) lines.push(`l ${JSON.stringify(key)} ${JSON.stringify(readlinkSync(full))}`);
      else if (stat.isDirectory()) { lines.push(`d ${JSON.stringify(key)}`); walk(full, key); }
      else if (stat.isFile()) lines.push(`f ${JSON.stringify(key)} ${stat.mode & 0o111 ? "x" : "-"} ${sha256Hex(readFileSync(full))}`);
      else throw feedError(`${full} is a special file; a fed volume carries only files, directories and symlinks`);
    }
  };
  walk(root, "");
  return sha256Hex(`directory\n${lines.join("\n")}\n`);
};

export const fetchFeedSource = (spec: FeedSourceSpec, { exec = hostExec }: { exec?: FeedExec } = {}): void => {
  if (spec.kind !== "git" || !spec.fetch) return;
  try { exec("git", ["-C", spec.repo, "fetch", "--prune", "--quiet", "origin"]); }
  catch (error) { throw feedError(`could not fetch the feed repository ${spec.repo}: ${String((error as Error).message).trim().slice(0, 300)}`); }
};

export const resolveFeedSource = (spec: FeedSourceSpec, { exec = hostExec }: { exec?: FeedExec } = {}): ResolvedFeedSource => {
  if (spec.kind === "directory") {
    let stat;
    try { stat = lstatSync(spec.directory); } catch { throw feedError(`feed directory ${spec.directory} does not exist`); }
    if (!stat.isDirectory()) throw feedError(`feed directory ${spec.directory} is not a directory`);
    return { provenance: { kind: "directory" }, revision: digestDirectory(spec.directory) };
  }
  let commit: string;
  const trees: string[] = [];
  try {
    commit = gitOut(exec, spec.repo, ["rev-parse", "--verify", "--end-of-options", `${spec.ref}^{commit}`]);
    for (const entry of spec.paths ?? [""]) {
      const tree = gitOut(exec, spec.repo, ["rev-parse", "--verify", "--end-of-options", entry ? `${commit}:${entry}` : `${commit}^{tree}`]);
      if (gitOut(exec, spec.repo, ["cat-file", "-t", tree]) !== "tree") throw new Error(`${entry} is not a directory at ${commit.slice(0, 12)}`);
      trees.push(`${entry}\0${tree}`);
    }
  } catch (error) {
    throw feedError(`cannot resolve ${spec.ref}${spec.paths ? ` (${spec.paths.join(", ")})` : ""} in ${spec.repo}: ${String((error as Error).message).trim().slice(0, 300)}`);
  }
  return {
    provenance: { commit, kind: "git", paths: spec.paths ?? null, ref: spec.ref },
    revision: sha256Hex(`git\n${trees.join("\n")}\n`)
  };
};

/**
 * Copies the source into `stagingDir` (which must exist and be empty) and returns the revision of what
 * was actually staged. For a directory that is re-derived from the copy, so a source edited mid-copy
 * lands as the bytes that were copied, under their own revision, never as a mislabelled mix.
 */
export const stageFeedSource = (
  spec: FeedSourceSpec,
  resolved: ResolvedFeedSource,
  stagingDir: string,
  { exec = hostExec }: { exec?: FeedExec } = {}
): ResolvedFeedSource => {
  if (spec.kind === "directory") {
    cpSync(spec.directory, stagingDir, { errorOnExist: true, force: false, preserveTimestamps: true, recursive: true, verbatimSymlinks: true });
    if (readdirSync(stagingDir).length === 0) throw feedError(`feed directory ${spec.directory} is empty; a fed volume never serves nothing`);
    return { ...resolved, revision: digestDirectory(stagingDir) };
  }
  const provenance = resolved.provenance as Extract<FeedProvenance, { kind: "git" }>;
  const archive = exec("git", ["-C", spec.repo, "archive", "--format=tar", provenance.commit, ...(spec.paths ? ["--", ...spec.paths] : [])]);
  exec("tar", ["-x", "-C", stagingDir], { input: archive });
  if (readdirSync(stagingDir).length === 0) {
    throw feedError(`extracting ${provenance.commit.slice(0, 12)} produced an empty tree in ${stagingDir}; a fed volume never serves nothing`);
  }
  return resolved;
};
