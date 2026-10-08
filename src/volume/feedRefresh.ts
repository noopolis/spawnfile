// `spawnfile volume refresh` and `spawnfile volume verify`, under the single-writer lock.
//
// A refresh lands a new revision when the source moved. When it did not, it sweeps the volume against
// the host record and heals what it can: re-lands a drifted tree from the source, restores the `current`
// link, republishes the identity record. A tree that keeps drifting is re-landed at most `healLimit` times
// before auto-repair is suspended: something is rewriting it, and an endless re-land loop hides that.

import { mkdirSync } from "node:fs";

import { assertFeedVolumeRoot, assertOutsideVolume, assertSameDevice, feedTreeLink, LINK_OPS, pointCurrent } from "./feedLayout.js";
import { buildFeedManifest, writeFeedManifest } from "./feedManifest.js";
import { landFeed, type FeedRuntime } from "./feedLand.js";
import { acquireFeedLock } from "./feedLock.js";
import { readFeedLanded, writeFeedIdentity, writeFeedLanded, type FeedLandedRecord } from "./feedRecord.js";
import { fetchFeedSource, hostExec, resolveFeedSource } from "./feedSource.js";
import { feedStagingDir, feedTrashDir, type FeedTarget } from "./feedTarget.js";
import { sweepFeed, type FeedSweep } from "./feedVerify.js";
import path from "node:path";

export type FeedRefreshStatus = "busy" | "current" | "landed" | "repaired" | "suspended" | "tampered";

export interface FeedRefreshResult {
  findings: string[];
  previous: string | null;
  revision: string | null;
  status: FeedRefreshStatus;
}

/** Clean means nothing needs a human: exit 0. */
export const feedResultClean = (result: FeedRefreshResult): boolean =>
  result.status === "busy" || result.status === "current" || (result.status === "landed" && result.findings.length === 0);

const prepare = (target: FeedTarget): void => {
  assertFeedVolumeRoot(target.volume);
  assertOutsideVolume(target.volume, target.stateDir, "the feed state directory");
  for (const [label, directory] of [["the feed staging directory", feedStagingDir(target)], ["the feed trash directory", feedTrashDir(target)]] as const) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    assertSameDevice(target.volume, directory, label);
  }
};

const withLock = (target: FeedTarget, log: (line: string) => void, run: () => FeedRefreshResult): FeedRefreshResult => {
  const lock = acquireFeedLock(target.stateDir);
  if (!lock) {
    log(`another writer holds ${path.join(target.stateDir, "lock")}; nothing to do`);
    return { findings: [], previous: null, revision: null, status: "busy" };
  }
  try { return run(); } finally { lock.release(); }
};

const repairable = (sweep: FeedSweep): boolean => sweep.drift || sweep.relink || sweep.identity !== null;

const heal = (target: FeedTarget, record: FeedLandedRecord, sweep: FeedSweep, runtime: FeedRuntime): FeedRefreshResult => {
  const log = runtime.log ?? (() => undefined);
  const base = { findings: sweep.findings, previous: record.revision, revision: record.revision };
  for (const finding of sweep.findings) log(`TAMPER: ${finding}`);
  if (sweep.failed || sweep.planted || sweep.blocked) return { ...base, status: "tampered" };
  if (sweep.drift) {
    const cycles = record.heals[record.revision] ?? 0;
    if (cycles >= target.healLimit) {
      log(`auto-repair suspended: ${record.revision.slice(0, 12)} was re-landed ${cycles} times and drifted again; the last tree is left exactly where it is`);
      return { ...base, status: "suspended" };
    }
    const resolved = resolveFeedSource(target.source, { exec: runtime.exec ?? hostExec });
    if (resolved.revision !== record.revision) {
      landFeed(target, resolved, record, { runtime });
      return { ...base, revision: resolved.revision, status: "repaired" };
    }
    log(`re-landing ${record.revision.slice(0, 12)} from the source`);
    landFeed(target, resolved, record, { force: true, heals: { ...record.heals, [record.revision]: cycles + 1 }, runtime });
    return { ...base, status: "repaired" };
  }
  if (sweep.relink) pointCurrent(target.volume, feedTreeLink(record.revision), { ops: runtime.ops ?? LINK_OPS, tmpDir: feedStagingDir(target) });
  let next = record;
  if (sweep.identity) next = { ...record, identity_sha256: writeFeedIdentity(target.volume, record.identity, { owner: target.owner, tmpDir: feedStagingDir(target) }) };
  writeFeedLanded(target.stateDir, next);
  const after = sweepFeed(target, next);
  if (repairable(after)) return { findings: [...sweep.findings, ...after.findings.map((finding) => `still after repair: ${finding}`)], previous: record.revision, revision: record.revision, status: "tampered" };
  return { ...base, status: repairable(sweep) && sweep.unknown.length === 0 ? "repaired" : "tampered" };
};

const refreshLocked = (target: FeedTarget, runtime: FeedRuntime): FeedRefreshResult => {
  const log = runtime.log ?? (() => undefined), exec = runtime.exec ?? hostExec;
  prepare(target);
  fetchFeedSource(target.source, { exec });
  const resolved = resolveFeedSource(target.source, { exec });
  const { reason, record } = readFeedLanded(target.stateDir);
  if (reason) log(`ignoring the host record: ${reason}; treating this volume as carrying nothing`);
  if (!record || record.revision !== resolved.revision) {
    log(`refresh needed: ${record ? `${record.revision.slice(0, 12)} -> ${resolved.revision.slice(0, 12)}` : `nothing landed -> ${resolved.revision.slice(0, 12)}`}`);
    const landed = landFeed(target, resolved, record, { runtime });
    const findings = landed.unknownTrees.map((name) => `trees/${name} is not a tree this host landed`);
    return { findings, previous: record?.revision ?? null, revision: landed.revision, status: "landed" };
  }
  const sweep = sweepFeed(target, record);
  if (!sweep.findings.length) {
    // Same bytes, moved mtime: somebody wrote to the mount without changing content. Re-stamp the manifest.
    if (sweep.touched.length) writeFeedManifest(target.stateDir, buildFeedManifest(path.join(target.volume, feedTreeLink(record.revision)), record.revision));
    if (Object.keys(record.heals).length) writeFeedLanded(target.stateDir, { ...record, heals: {} });
    log(`already current: ${record.revision.slice(0, 12)}`);
    return { findings: [], previous: record.revision, revision: record.revision, status: "current" };
  }
  return heal(target, record, sweep, runtime);
};

export const refreshVolumeFeed = (target: FeedTarget, runtime: FeedRuntime = {}): FeedRefreshResult =>
  withLock(target, runtime.log ?? (() => undefined), () => refreshLocked(target, runtime));

/** Read-only: reports what a refresh would heal, changes nothing. Taken under the lock so a swap in flight is never misread. */
export const verifyVolumeFeed = (target: FeedTarget, runtime: Pick<FeedRuntime, "log"> = {}): FeedRefreshResult =>
  withLock(target, runtime.log ?? (() => undefined), () => {
    assertFeedVolumeRoot(target.volume);
    const { reason, record } = readFeedLanded(target.stateDir);
    if (!record) return { findings: [reason ?? "nothing has been landed in this volume yet"], previous: null, revision: null, status: "tampered" };
    const sweep = sweepFeed(target, record);
    return { findings: sweep.findings, previous: record.revision, revision: record.revision, status: sweep.findings.length ? "tampered" : "current" };
  });
