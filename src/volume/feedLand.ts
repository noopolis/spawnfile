// The mutating half of a refresh: stage, validate, freeze, land, point `current`, publish the identity,
// record, collect garbage. Read feedLayout.ts first: it owns every rule about what may touch the volume.
//
// WHAT THIS FILE DECIDES FROM, EXHAUSTIVELY: the host record and manifests outside the volume, the
// source, and the host clock. The volume itself is read only to assert that what is about to be touched
// is the real directory the host created, and to find a tree name nobody occupies.
//
// GENERATIONS, NOT REPLACEMENTS. A tree is never replaced under its own name: a re-land of revision R
// lands as `trees/R.1` (then `.2`, ...) beside the drifted `trees/R`, `current` moves to it with one
// rename, and the drifted tree is retired later like any other. So `current` never dangles, not even
// between two adjacent renames, and nothing the host did not record is ever parked or deleted.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  FEED_TREES_DIR, LINK_OPS, assertRealDirectory, feedError, feedTreeLink, landTree, ownAndFreeze, parkTree,
  pointCurrent, removeTree, type LinkOps
} from "./feedLayout.js";
import { buildFeedManifest, compareFeedManifest, manifestDrift, readFeedManifest, removeFeedManifest, writeFeedManifest } from "./feedManifest.js";
import { FEED_IDENTITY_VERSION, FEED_LANDED_VERSION, writeFeedIdentity, writeFeedLanded, type FeedLandedRecord } from "./feedRecord.js";
import { digestDirectory, hostExec, stageFeedSource, type FeedExec, type ResolvedFeedSource } from "./feedSource.js";
import { feedStagingDir, feedTrashDir, type FeedTarget } from "./feedTarget.js";

export interface FeedRuntime {
  exec?: FeedExec;
  log?: (line: string) => void;
  now?: () => Date;
  ops?: LinkOps;
}

export interface FeedLandResult {
  revision: string;
  reused: boolean;
  tree: string;
  treesRemoved: string[];
  unknownTrees: string[];
}

export const isoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
const stampOf = (date: Date): string => `${isoSeconds(date).replace(/[:-]/gu, "")}.${process.pid}`;

/**
 * The declared validation hook: the gate between "staged" and "reachable". Non-zero exit lands nothing.
 * It validates; it may not edit: the tree is digested before and after, and any change is a refusal,
 * because changed bytes would be served under a revision that does not describe them.
 */
export const runFeedValidation = (target: FeedTarget, tree: string, resolved: ResolvedFeedSource): void => {
  if (!target.validate) return;
  const before = digestDirectory(tree);
  const [command, ...args] = target.validate.command;
  const result = spawnSync(command, args, {
    cwd: target.validate.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      SPAWNFILE_FEED_PROVENANCE: JSON.stringify(resolved.provenance),
      SPAWNFILE_FEED_RESOURCE: target.resourceId,
      SPAWNFILE_FEED_REVISION: resolved.revision,
      SPAWNFILE_FEED_TREE: tree
    },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: target.validate.timeoutMs
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw feedError(`the feed validation command for ${target.resourceId} did not finish within ${Math.round(target.validate.timeoutMs / 1000)}s and was killed; nothing was landed`);
  }
  if (result.error) throw feedError(`the feed validation command for ${target.resourceId} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-20).join("\n");
    throw feedError(`the feed validation command rejected revision ${resolved.revision.slice(0, 12)} of ${target.resourceId} (${result.signal ? `killed by ${result.signal}` : `exit ${result.status}`}); nothing was landed${output ? `:\n${output}` : ""}`);
  }
  if (digestDirectory(tree) !== before) throw feedError(`the feed validation command for ${target.resourceId} modified the tree it was validating; a validation hook may only read it, so nothing was landed`);
};

const treesDirOf = (target: FeedTarget): string => path.join(target.volume, FEED_TREES_DIR);

const treeMatches = (target: FeedTarget, name: string): boolean => {
  const treePath = path.join(treesDirOf(target), name);
  if (!assertRealDirectory(treePath, `the fed tree ${FEED_TREES_DIR}/${name.slice(0, 12)}`)) return false;
  const manifest = readFeedManifest(target.stateDir, name);
  return manifest !== null && manifestDrift(compareFeedManifest(treePath, manifest)).length === 0;
};

/** The first name for `revision` that nothing occupies -- whatever occupies the others, the host never moves it. */
const freshTreeName = (target: FeedTarget, revision: string): string => {
  for (let generation = 0; ; generation += 1) {
    const name = generation === 0 ? revision : `${revision}.${generation}`;
    try { lstatSync(path.join(treesDirOf(target), name)); } catch { return name; }
  }
};

/** Copies, validates, owns and freezes OUTSIDE the volume, then moves the finished tree in with one rename. */
const stageAndLand = (target: FeedTarget, resolved: ResolvedFeedSource, { exec, log }: { exec: FeedExec; log: (line: string) => void }): { name: string; resolved: ResolvedFeedSource } => {
  const stagingDir = path.join(feedStagingDir(target), `${resolved.revision}-${process.pid}`);
  removeTree(stagingDir, { volume: target.volume });
  mkdirSync(stagingDir);
  let staged: ResolvedFeedSource;
  try {
    staged = stageFeedSource(target.source, resolved, stagingDir, { exec });
    if (staged.revision !== resolved.revision) log(`the source moved while it was copied; landing what was copied as ${staged.revision.slice(0, 12)}`);
    runFeedValidation(target, stagingDir, staged);
    ownAndFreeze(stagingDir, { owner: target.owner, volume: target.volume });
  } catch (error) {
    try { removeTree(stagingDir, { volume: target.volume }); } catch { /* the original error says more */ }
    throw error;
  }
  const name = freshTreeName(target, staged.revision);
  writeFeedManifest(target.stateDir, buildFeedManifest(stagingDir, name));
  landTree(stagingDir, path.join(treesDirOf(target), name));
  log(`landed ${FEED_TREES_DIR}/${name.slice(0, 12)}${name.length > 64 ? name.slice(64) : ""}`);
  return { name, resolved: staged };
};

/**
 * Retires recorded trees beyond `keep`, oldest-served first by the host's own order (never by
 * filesystem mtimes). Names the host never recorded are reported and left in place.
 */
const collectGarbage = (target: FeedTarget, order: string[], serving: string, now: Date): { removed: string[]; unknown: string[] } => {
  const treesDir = treesDirOf(target);
  if (!assertRealDirectory(treesDir, "the fed volume's trees/ directory")) return { removed: [], unknown: [] };
  const present = readdirSync(treesDir, { withFileTypes: true });
  const real = new Set(present.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const unknown = present.map((entry) => entry.name).filter((name) => !order.includes(name)).sort();
  const retired = order.filter((name) => name !== serving);
  const doomed = retired.slice(0, Math.max(0, retired.length - target.keep));
  for (const name of doomed) {
    if (!real.has(name)) continue;
    removeTree(parkTree(path.join(treesDir, name), feedTrashDir(target), stampOf(now)), { volume: target.volume });
  }
  return { removed: doomed, unknown };
};

export const landFeed = (
  target: FeedTarget,
  resolved: ResolvedFeedSource,
  record: FeedLandedRecord | null,
  { force = false, heals = {}, runtime = {} }: { force?: boolean; heals?: Record<string, number>; runtime?: FeedRuntime } = {}
): FeedLandResult => {
  const now = (runtime.now ?? (() => new Date()))(), log = runtime.log ?? (() => undefined), exec = runtime.exec ?? hostExec;
  if (!assertRealDirectory(treesDirOf(target), "the fed volume's trees/ directory")) mkdirSync(treesDirOf(target), { mode: 0o755 });
  // A retained tree for this revision is reused only when the host recorded it and its manifest still
  // describes it -- and it passes the validation policy as declared NOW, like any new tree.
  const retained = force ? undefined : [...(record?.trees ?? [])].reverse().find((name) => name.slice(0, 64) === resolved.revision && treeMatches(target, name));
  let name: string, landedSource = resolved;
  if (retained) {
    runFeedValidation(target, path.join(treesDirOf(target), retained), resolved);
    name = retained;
  } else ({ name, resolved: landedSource } = stageAndLand(target, resolved, { exec, log }));
  const revision = landedSource.revision;
  if (pointCurrent(target.volume, feedTreeLink(name), { ops: runtime.ops ?? LINK_OPS, tmpDir: feedStagingDir(target) })) log(`current -> ${feedTreeLink(name.slice(0, 12))}`);
  const manifest = readFeedManifest(target.stateDir, name) ?? buildFeedManifest(path.join(treesDirOf(target), name), name);
  const identity = {
    files: manifest.files, landed_at: isoSeconds(now), resource: target.resourceId, revision, source: landedSource.provenance,
    tree: feedTreeLink(name), version: FEED_IDENTITY_VERSION, volume: target.volumeName
  } as const;
  const identitySha = writeFeedIdentity(target.volume, identity, { owner: target.owner, tmpDir: feedStagingDir(target) });
  // Order is serving history: the serving tree is always last.
  let trees = [...(record?.trees ?? []).filter((entry) => entry !== name), name];
  const write = (): FeedLandedRecord => writeFeedLanded(target.stateDir, { heals, identity, identity_sha256: identitySha, revision, tree: name, trees, version: FEED_LANDED_VERSION });
  write();
  const gc = collectGarbage(target, trees, name, now);
  if (gc.removed.length) {
    for (const removed of gc.removed) removeFeedManifest(target.stateDir, removed);
    trees = trees.filter((entry) => !gc.removed.includes(entry));
    write();
    log(`retired ${gc.removed.length} tree(s): ${gc.removed.map((entry) => entry.slice(0, 12)).join(", ")}`);
  }
  return { revision, reused: retained !== undefined, tree: name, treesRemoved: gc.removed, unknownTrees: gc.unknown };
};
