// The mutating half of a refresh: stage, validate, freeze, land, point `current`, publish the identity,
// record, collect garbage. Read feedLayout.ts first: it owns every rule about what may touch the volume.
//
// WHAT THIS FILE DECIDES FROM, EXHAUSTIVELY: the host record and manifests outside the volume, the
// source, and the host clock. The volume itself is read only to assert that what is about to be touched
// is the real directory the host created.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, chmodSync, statSync } from "node:fs";
import path from "node:path";

import {
  FEED_TREES_DIR, LINK_OPS, assertRealDirectory, feedError, feedTreeLink, landTree, ownAndFreeze, parkTree,
  pointCurrent, removeTree, type LinkOps
} from "./feedLayout.js";
import { buildFeedManifest, compareFeedManifest, manifestDrift, readFeedManifest, removeFeedManifest, writeFeedManifest } from "./feedManifest.js";
import { FEED_IDENTITY_VERSION, FEED_LANDED_VERSION, writeFeedIdentity, writeFeedLanded, type FeedLandedRecord } from "./feedRecord.js";
import { hostExec, stageFeedSource, type FeedExec, type ResolvedFeedSource } from "./feedSource.js";
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
  treesRemoved: string[];
  unknownTrees: string[];
}

export const isoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
const stampOf = (date: Date): string => `${isoSeconds(date).replace(/[:-]/gu, "")}.${process.pid}`;

/** The declared validation hook: the gate between "staged" and "reachable". Non-zero exit lands nothing. */
export const runFeedValidation = (target: FeedTarget, stagingDir: string, resolved: ResolvedFeedSource): void => {
  if (!target.validate) return;
  const [command, ...args] = target.validate.command;
  const result = spawnSync(command, args, {
    cwd: target.validate.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      SPAWNFILE_FEED_PROVENANCE: JSON.stringify(resolved.provenance),
      SPAWNFILE_FEED_RESOURCE: target.resourceId,
      SPAWNFILE_FEED_REVISION: resolved.revision,
      SPAWNFILE_FEED_TREE: stagingDir
    },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: target.validate.timeoutMs
  });
  if (result.error) throw feedError(`the feed validation command for ${target.resourceId} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-20).join("\n");
    throw feedError(`the feed validation command rejected revision ${resolved.revision.slice(0, 12)} of ${target.resourceId} (${result.signal ? `killed by ${result.signal}` : `exit ${result.status}`}); nothing was landed${output ? `:\n${output}` : ""}`);
  }
};

const manifestMatches = (target: FeedTarget, treePath: string, revision: string): boolean => {
  const manifest = readFeedManifest(target.stateDir, revision);
  return manifest !== null && manifestDrift(compareFeedManifest(treePath, manifest)).length === 0;
};

interface Staged { parked: string | null; resolved: ResolvedFeedSource; reused: boolean; treePath: string }

/**
 * Copies, validates, owns and freezes OUTSIDE the volume, then moves the finished tree in with one rename.
 * A tree already under `trees/<revision>` is reused only when the host's manifest still describes it;
 * adopting an unverifiable tree would launder the tampering this design exists to notice.
 */
const stage = (target: FeedTarget, resolved: ResolvedFeedSource, { force, now, exec, log }: { exec: FeedExec; force: boolean; log: (line: string) => void; now: Date }): Staged => {
  const treeFor = (revision: string): string => path.join(target.volume, feedTreeLink(revision));
  const existingTree = (revision: string) => assertRealDirectory(treeFor(revision), `the fed tree ${feedTreeLink(revision.slice(0, 12))}`);
  if (!force && existingTree(resolved.revision) && manifestMatches(target, treeFor(resolved.revision), resolved.revision)) {
    return { parked: null, resolved, reused: true, treePath: treeFor(resolved.revision) };
  }
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
  const treePath = treeFor(staged.revision);
  const existing = existingTree(staged.revision);
  if (existing && !force && manifestMatches(target, treePath, staged.revision)) {
    removeTree(stagingDir, { volume: target.volume });
    return { parked: null, resolved: staged, reused: true, treePath };
  }
  writeFeedManifest(target.stateDir, buildFeedManifest(stagingDir, staged.revision));
  // Park and land back to back: links into the old tree dangle only between these two renames, and the
  // old tree is deleted only after `current` points at its replacement.
  const parked = existing ? parkTree(treePath, feedTrashDir(target), `evicted-${stampOf(now)}`) : null;
  try { landTree(stagingDir, treePath); } catch (error) {
    if (parked && !existsSync(treePath)) { try { renameSync(parked, treePath); chmodSync(treePath, 0o555); } catch { /* reported by the throw */ } }
    throw error;
  }
  log(`landed ${feedTreeLink(staged.revision.slice(0, 12))}`);
  return { parked, resolved: staged, reused: false, treePath };
};

/** Retires host-known trees beyond `keep`; names the host never landed are reported and left in place. */
const collectGarbage = (target: FeedTarget, known: string[], serving: string, now: Date): { removed: string[]; unknown: string[] } => {
  const treesDir = path.join(target.volume, FEED_TREES_DIR);
  if (!assertRealDirectory(treesDir, "the fed volume's trees/ directory")) return { removed: [], unknown: [] };
  const present = readdirSync(treesDir, { withFileTypes: true });
  const real = new Set(present.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const unknown = present.map((entry) => entry.name).filter((name) => !known.includes(name)).sort();
  const doomed = known.filter((name) => name !== serving && real.has(name))
    .map((name) => ({ mtime: statSync(path.join(treesDir, name)).mtimeMs, name }))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(target.keep);
  for (const entry of doomed) {
    const parked = parkTree(path.join(treesDir, entry.name), feedTrashDir(target), stampOf(now));
    removeTree(parked, { volume: target.volume });
  }
  return { removed: doomed.map((entry) => entry.name), unknown };
};

export const landFeed = (
  target: FeedTarget,
  resolved: ResolvedFeedSource,
  record: FeedLandedRecord | null,
  { force = false, heals = {}, runtime = {} }: { force?: boolean; heals?: Record<string, number>; runtime?: FeedRuntime } = {}
): FeedLandResult => {
  const now = (runtime.now ?? (() => new Date()))(), log = runtime.log ?? (() => undefined), exec = runtime.exec ?? hostExec;
  const treesDir = path.join(target.volume, FEED_TREES_DIR);
  if (!assertRealDirectory(treesDir, "the fed volume's trees/ directory")) mkdirSync(treesDir, { mode: 0o755 });
  const staged = stage(target, resolved, { exec, force, log, now });
  const revision = staged.resolved.revision;
  try {
    if (pointCurrent(target.volume, feedTreeLink(revision), { ops: runtime.ops ?? LINK_OPS, tmpDir: feedStagingDir(target) })) log(`current -> ${feedTreeLink(revision.slice(0, 12))}`);
  } finally {
    if (staged.parked) { try { removeTree(staged.parked, { volume: target.volume }); } catch (error) { log(`could not delete the replaced tree at ${staged.parked}: ${(error as Error).message}`); } }
  }
  const manifest = readFeedManifest(target.stateDir, revision) ?? buildFeedManifest(staged.treePath, revision);
  const identity = {
    files: manifest.files, landed_at: isoSeconds(now), resource: target.resourceId, revision, source: staged.resolved.provenance,
    tree: feedTreeLink(revision), version: FEED_IDENTITY_VERSION, volume: target.volumeName
  } as const;
  const identitySha = writeFeedIdentity(target.volume, identity, { owner: target.owner, tmpDir: feedStagingDir(target) });
  if (!readFeedManifest(target.stateDir, revision)) writeFeedManifest(target.stateDir, manifest);
  let trees = [...new Set([...(record?.trees ?? []), revision])].sort();
  const write = (): FeedLandedRecord => writeFeedLanded(target.stateDir, { heals, identity, identity_sha256: identitySha, revision, trees, version: FEED_LANDED_VERSION });
  write();
  const gc = collectGarbage(target, trees, revision, now);
  if (gc.removed.length) {
    for (const name of gc.removed) removeFeedManifest(target.stateDir, name);
    trees = trees.filter((name) => !gc.removed.includes(name));
    write();
    log(`retired ${gc.removed.length} tree(s): ${gc.removed.map((name) => name.slice(0, 12)).join(", ")}`);
  }
  return { revision, reused: staged.reused, treesRemoved: gc.removed, unknownTrees: gc.unknown };
};
