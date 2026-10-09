// `spawnfile volume refresh` and `spawnfile volume verify`, under the single-writer lock.
//
// A refresh lands a new revision when the source moved. When it did not, it sweeps the volume against
// the host record and heals what it can: re-lands a drifted tree from the source (beside it, as a new
// generation), restores the `current` link, republishes the identity record. One revision is re-landed at
// most `healLimit` times; the count survives clean refreshes and resets only when a new revision lands,
// so tampering that alternates with quiet periods cannot buy unlimited repairs.

import { mkdirSync } from "node:fs";
import path from "node:path";

import { assertFeedVolumeRoot, assertOutsideVolume, assertSameDevice, auditFeedRoot, feedTreeLink, LINK_OPS, pointCurrent } from "./feedLayout.js";
import { buildFeedManifest, writeFeedManifest } from "./feedManifest.js";
import { landFeed, type FeedRuntime } from "./feedLand.js";
import { acquireFeedLock } from "./feedLock.js";
import { resolveFeedContent } from "./feedPrepare.js";
import { readFeedLanded, writeFeedIdentity, writeFeedLanded, type FeedLandedRecord } from "./feedRecord.js";
import { chooseFeedRef, expandFeedPaths, feedFrozen, feedPeriod } from "./feedRef.js";
import { fetchFeedSource, hostExec, type ResolvedFeedSource } from "./feedSource.js";
import { feedStagingDir, feedTrashDir, type FeedTarget } from "./feedTarget.js";
import { sweepFeed, type FeedSweep } from "./feedVerify.js";

/** `frozen` and `waiting` are clean holds: the volume keeps serving what it has (see feedRef.ts). */
export type FeedRefreshStatus = "busy" | "current" | "frozen" | "landed" | "repaired" | "suspended" | "tampered" | "waiting";

export interface FeedRefreshResult {
  findings: string[];
  previous: string | null;
  revision: string | null;
  status: FeedRefreshStatus;
}

/** Clean means nothing needs a human: exit 0. */
export const feedResultClean = (result: FeedRefreshResult): boolean =>
  result.status === "busy" || result.status === "current" || result.status === "frozen" || result.status === "waiting" ||
  (result.status === "landed" && result.findings.length === 0);

/** Every check that decides where host state may be written runs before anything -- the lock included -- is written. */
const confine = (target: FeedTarget): void => {
  assertFeedVolumeRoot(target.volume);
  assertOutsideVolume(target.volume, target.stateDir, "the feed state directory");
};

const prepare = (target: FeedTarget): void => {
  for (const [label, directory] of [["the feed staging directory", feedStagingDir(target)], ["the feed trash directory", feedTrashDir(target)]] as const) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    assertSameDevice(target.volume, directory, label);
  }
};

const withLock = (target: FeedTarget, log: (line: string) => void, run: () => FeedRefreshResult): FeedRefreshResult => {
  confine(target);
  const lock = acquireFeedLock(target.stateDir);
  if (!lock) {
    log(`another writer holds ${path.join(target.stateDir, "lock")}; nothing to do`);
    return { findings: [], previous: null, revision: null, status: "busy" };
  }
  try { return run(); } finally { lock.release(); }
};

const repairable = (sweep: FeedSweep): boolean => sweep.drift || sweep.relink || sweep.identity !== null;

const heal = (target: FeedTarget, record: FeedLandedRecord, sweep: FeedSweep, runtime: FeedRuntime, { held = false }: { held?: boolean } = {}): FeedRefreshResult => {
  const log = runtime.log ?? (() => undefined);
  const base = { findings: sweep.findings, previous: record.revision, revision: record.revision };
  for (const finding of sweep.findings) log(`TAMPER: ${finding}`);
  if (sweep.failed || sweep.planted || sweep.blocked) return { ...base, status: "tampered" };
  if (sweep.drift) {
    const cycles = record.heals[record.revision] ?? 0;
    if (cycles >= target.healLimit) {
      log(`auto-repair suspended: ${record.revision.slice(0, 12)} was re-landed ${cycles} times and drifted again; it resumes when a new revision lands`);
      return { ...base, status: "suspended" };
    }
    const resolved = resolveFeedContent(target, { exec: runtime.exec ?? hostExec });
    if (resolved.revision !== record.revision) {
      // A held volume never advances, not even to repair itself.
      if (held) return { ...base, findings: [...sweep.findings, `the volume is held at ${record.revision.slice(0, 12)} and its source no longer reproduces it (now ${resolved.revision.slice(0, 12)}); not re-landing while held`], status: "tampered" };
      landFeed(target, resolved, record, { period: feedPeriod(target, (runtime.now ?? (() => new Date()))()), runtime });
      return { ...base, revision: resolved.revision, status: "repaired" };
    }
    log(`re-landing ${record.revision.slice(0, 12)} from the source beside the drifted tree`);
    landFeed(target, resolved, record, { exact: held, force: true, heals: { ...record.heals, [record.revision]: cycles + 1 }, ...(record.period ? { period: record.period } : {}), runtime });
    return { ...base, status: "repaired" };
  }
  if (sweep.relink) pointCurrent(target.volume, feedTreeLink(record.tree), { ops: runtime.ops ?? LINK_OPS, tmpDir: feedStagingDir(target) });
  let next = record;
  if (sweep.identity) next = { ...record, identity_sha256: writeFeedIdentity(target.volume, record.identity, { owner: target.owner, tmpDir: feedStagingDir(target) }) };
  writeFeedLanded(target.stateDir, next);
  const after = sweepFeed(target, next);
  if (repairable(after)) return { findings: [...sweep.findings, ...after.findings.map((finding) => `still after repair: ${finding}`)], previous: record.revision, revision: record.revision, status: "tampered" };
  return { ...base, status: repairable(sweep) && sweep.unknown.length === 0 ? "repaired" : "tampered" };
};

/**
 * Same bytes under a new period or ref name: the serving revision is now this period's content, so its
 * period and provenance are re-stamped (record, then the identity agents read). Without it a ref that
 * moved to identical content would never count as landed this period, and the freeze would never hold.
 */
const adopt = (target: FeedTarget, record: FeedLandedRecord, resolved: ResolvedFeedSource, period: string | undefined): void => {
  const source = resolved.provenance;
  if (!period || (record.period === period && JSON.stringify(record.identity.source) === JSON.stringify(source))) return;
  const identity = { ...record.identity, source };
  const identitySha = writeFeedIdentity(target.volume, identity, { owner: target.owner, tmpDir: feedStagingDir(target) });
  writeFeedLanded(target.stateDir, { ...record, identity, identity_sha256: identitySha, period });
};

/** A held volume (frozen, or waiting for a ref that does not exist yet) keeps serving what it has; it is still verified and healed. */
const holdLocked = (target: FeedTarget, record: FeedLandedRecord, held: "frozen" | "waiting", runtime: FeedRuntime): FeedRefreshResult => {
  const sweep = sweepFeed(target, record);
  if (sweep.findings.length) return heal(target, record, sweep, runtime, { held: true });
  (runtime.log ?? (() => undefined))(`${held}: serving ${record.revision.slice(0, 12)}`);
  return { findings: [], previous: record.revision, revision: record.revision, status: held };
};

const refreshLocked = (target: FeedTarget, runtime: FeedRuntime): FeedRefreshResult => {
  const log = runtime.log ?? (() => undefined), exec = runtime.exec ?? hostExec, now = (runtime.now ?? (() => new Date()))();
  prepare(target);
  fetchFeedSource(target.source, { exec });
  const { reason, record } = readFeedLanded(target.stateDir);
  if (reason) log(`ignoring the host record: ${reason}; treating this volume as carrying nothing`);
  const choice = chooseFeedRef(target, { exec, now });
  let concrete = target;
  // Path templates expand at the same instant the ref was chosen from.
  const paths = target.source.kind === "git" ? expandFeedPaths(target.source.paths, now) : undefined;
  if (choice.kind === "waiting") {
    log(choice.reason);
    if (!record) return { findings: [], previous: null, revision: null, status: "waiting" };
  } else if (target.source.kind === "git") concrete = { ...target, source: { ...target.source, ...(paths ? { paths } : {}), ref: choice.ref } };
  const frozen = choice.kind === "ref" && feedFrozen(target, record, choice.ref, now, paths);
  if (record && (choice.kind === "waiting" || frozen)) {
    if (frozen) log(`frozen: ${record.revision.slice(0, 12)} was landed this period and the ${target.freeze!.after} ${target.freeze!.timezone} cutoff has passed`);
    const landed = record.identity.source;
    // Held at its own commit and the paths it landed, so a heal reproduces what is served and never what
    // the ref moved to or what a path template expands to today.
    const held: FeedTarget = landed.kind === "git" && target.source.kind === "git"
      ? { ...target, source: { fetch: target.source.fetch, kind: "git", label: landed.ref, ...(landed.paths ? { paths: landed.paths } : {}), ref: landed.commit, repo: target.source.repo } } : target;
    return holdLocked(held, record, frozen ? "frozen" : "waiting", runtime);
  }
  const resolved = resolveFeedContent(concrete, { exec });
  const period = feedPeriod(target, now);
  if (!record || record.revision !== resolved.revision) {
    log(`refresh needed: ${record ? `${record.revision.slice(0, 12)} -> ${resolved.revision.slice(0, 12)}` : `nothing landed -> ${resolved.revision.slice(0, 12)}`}`);
    // A new revision does not excuse what else is in the volume: the root is audited on every landing.
    const findings = auditFeedRoot(target.volume);
    const landed = landFeed(concrete, resolved, record, { ...(period ? { period } : {}), runtime });
    findings.push(...landed.unknownTrees.map((name) => `trees/${name} is not a tree this host landed`));
    for (const finding of findings) log(`TAMPER: ${finding}`);
    return { findings, previous: record?.revision ?? null, revision: landed.revision, status: "landed" };
  }
  const sweep = sweepFeed(concrete, record);
  if (!sweep.findings.length) {
    // Same bytes, moved mtime: somebody touched the mount without changing content. Re-stamp the manifest.
    if (sweep.touched.length) writeFeedManifest(target.stateDir, buildFeedManifest(path.join(target.volume, feedTreeLink(record.tree)), record.tree));
    adopt(concrete, record, resolved, period);
    log(`already current: ${record.revision.slice(0, 12)}`);
    return { findings: [], previous: record.revision, revision: record.revision, status: "current" };
  }
  const healed = heal(concrete, record, sweep, runtime);
  // A repair of the content this period chose is this period's landing too.
  const after = healed.status === "repaired" ? readFeedLanded(target.stateDir).record : null;
  if (after && after.revision === resolved.revision) adopt(concrete, after, resolved, period);
  return healed;
};

export const refreshVolumeFeed = (target: FeedTarget, runtime: FeedRuntime = {}): FeedRefreshResult =>
  withLock(target, runtime.log ?? (() => undefined), () => refreshLocked(target, runtime));

/** Read-only: reports what a refresh would heal, changes nothing. Taken under the lock so a swap in flight is never misread. */
export const verifyVolumeFeed = (target: FeedTarget, runtime: Pick<FeedRuntime, "log"> = {}): FeedRefreshResult =>
  withLock(target, runtime.log ?? (() => undefined), () => {
    const { reason, record } = readFeedLanded(target.stateDir);
    if (!record) return { findings: [reason ?? "nothing has been landed in this volume yet"], previous: null, revision: null, status: "tampered" };
    const sweep = sweepFeed(target, record);
    return { findings: sweep.findings, previous: record.revision, revision: record.revision, status: sweep.findings.length ? "tampered" : "current" };
  });
