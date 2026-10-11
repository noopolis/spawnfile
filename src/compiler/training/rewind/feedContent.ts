import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digestDirectory, resolveFeedSource, type FeedExec, type FeedIdentity } from "../../../volume/index.js";
import { exportFeedGitTree } from "./gitArchive.js";
import { rewindGitSync } from "./gitProcess.js";

const revisionExec: FeedExec = (command, args) => {
  if (command !== "git" || args[0] !== "-C" || !args[1]) throw new Error("Feed revision may only read a local git repository");
  return rewindGitSync(args[1], args.slice(2));
};
export const feedGitRevision = (repo: string, commit: string, ref: string, paths?: string[] | null): string =>
  resolveFeedSource({ kind: "git", fetch: false, repo, ref: commit, label: ref, paths: paths?.length ? paths : undefined },
    { exec: revisionExec }).revision;

/** A prepared revision proves the recipe/source identity, never its output bytes. */
export const assertPreparedFeedRevision = (revision: string, prepared: NonNullable<FeedIdentity["source"]["prepared"]>): void => {
  const provenance = { include: prepared.include, prepare: prepared.prepare, source_revision: prepared.source_revision };
  const actual = createHash("sha256").update(`prepared\n${JSON.stringify(provenance)}\n`).digest("hex");
  if (actual !== revision) throw new Error("Prepared feed revision disagrees with its provenance");
};

/** Acceptance re-extracts from history; it does not consume any producer-computed content digest. */
export const verifyPlainFeedTree = async (repo: string, identity: FeedIdentity, directory: string): Promise<void> => {
  const source = identity.source;
  if (source.kind !== "git") throw new Error("Plain git feed verification requires git provenance");
  if (feedGitRevision(repo, source.commit, source.ref, source.paths) !== identity.revision) {
    throw new Error("Feed revision disagrees with selected commit and paths");
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "spawnfile-feed-check-"));
  try {
    await exportFeedGitTree(repo, source.commit, scratch, source.paths?.length ? source.paths : undefined);
    if (digestDirectory(directory) !== digestDirectory(scratch)) throw new Error("Git feed bytes disagree with selected commit and paths");
  } finally { await rm(scratch, { recursive: true, force: true }); }
};
