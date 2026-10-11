// Recording history is host state, beside landed.json, and survives retirement of the physical trees.
import path from "node:path";

import { appendRetainedJsonl, entryAt, readRetainedJsonl, syncFileSync } from "../filesystem/index.js";

import { isFeedRevision, isFeedTreeName, writeFeedLanded, type FeedLandedRecord } from "./feedRecord.js";
import type { FeedPreparedProvenance } from "./feedSource.js";
import type { FeedTarget } from "./feedTarget.js";

export const FEED_LANDING_VERSION = "spawnfile.volume-feed-landing.v1";
export const FEED_LANDINGS_FILE = "landings.jsonl";

export interface FeedLanding {
  version: typeof FEED_LANDING_VERSION;
  resource: string;
  volume: string;
  revision: string;
  tree: string;
  source: ({ kind: "git"; repo: string } | { kind: "directory"; directory: string }) & { prepared?: FeedPreparedProvenance };
  commit?: string;
  ref?: string;
  paths?: string[];
  switching_at: string;
  landed_at: string;
  period?: string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

const prepared = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!object(value) || !isFeedRevision(value.source_revision) || !Array.isArray(value.include)) return false;
  if (!value.include.every((entry: unknown) => object(entry) && isFeedRevision(entry.digest) && text(entry.to))) return false;
  const recipe = value.prepare;
  return recipe === null || (object(recipe) && stringArray(recipe.command)
    && (recipe.image === null || text(recipe.image)) && (recipe.network === null || typeof recipe.network === "boolean")
    && (recipe.platform === null || text(recipe.platform)));
};

export const isFeedLanding = (value: unknown): value is FeedLanding => {
  if (!object(value) || value.version !== FEED_LANDING_VERSION || !text(value.resource) || !text(value.volume)) return false;
  if (!isFeedRevision(value.revision) || !text(value.tree) || value.tree !== `trees/${value.tree.slice(6)}`
    || !isFeedTreeName(value.tree.slice(6)) || value.tree.slice(6, 70) !== value.revision) return false;
  if (!text(value.landed_at) || !Number.isFinite(Date.parse(value.landed_at))) return false;
  if (!text(value.switching_at) || !Number.isFinite(Date.parse(value.switching_at))
    || Date.parse(value.switching_at) > Date.parse(value.landed_at)) return false;
  if (value.period !== undefined && (typeof value.period !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.period))) return false;
  if (!object(value.source) || !prepared(value.source.prepared)) return false;
  if (value.source.kind === "directory") {
    return text(value.source.directory) && value.commit === undefined && value.ref === undefined && value.paths === undefined;
  }
  return value.source.kind === "git" && text(value.source.repo) && text(value.commit) && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value.commit)
    && text(value.ref) && (value.paths === undefined || stringArray(value.paths));
};

/** Invalid lines are findings beside valid entries; an absent log is an empty history. */
export const readFeedLandings = (stateDir: string): { entries: FeedLanding[]; errors: string[] } =>
  readRetainedJsonl(path.join(stateDir, FEED_LANDINGS_FILE), isFeedLanding);

/** A transition's inclusive window cannot identify which tree a concurrent reader observed. */
export const feedLandingAt = (entries: readonly FeedLanding[], instant: string | Date): (FeedLanding & { ambiguous?: true }) | null => {
  const at = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  const transition = entryAt(entries.filter((entry) => at <= Date.parse(entry.landed_at)), instant, (entry) => entry.switching_at);
  return transition ? { ...transition, ambiguous: true } : entryAt(entries, instant, (entry) => entry.landed_at);
};

type LandingTarget = Pick<FeedTarget, "stateDir" | "record"> & Partial<Pick<FeedTarget, "source">>;

const landingFromRecord = (target: LandingTarget, record: FeedLandedRecord): FeedLanding => {
  if (record.recording) return record.recording.landing;
  if (!target.source) throw new Error("Landed record has no recoverable recording provenance");
  const identity = record.identity, provenance = identity.source;
  const source: FeedLanding["source"] = target.source.kind === "git"
    ? { kind: "git", repo: target.source.repo }
    : { directory: target.source.directory, kind: "directory" };
  if (provenance.prepared) source.prepared = provenance.prepared;
  return {
    version: FEED_LANDING_VERSION, resource: identity.resource, volume: identity.volume,
    revision: identity.revision, tree: identity.tree, source, switching_at: identity.landed_at, landed_at: identity.landed_at,
    ...(provenance.kind === "git" ? { commit: provenance.commit, ref: provenance.ref, ...(provenance.paths ? { paths: provenance.paths } : {}) } : {}),
    ...(record.period ? { period: record.period } : {})
  };
};

/** Call only after writing the corresponding landed.json; the existing feed lock serializes writers. */
export const appendFeedLanding = (target: LandingTarget, record: FeedLandedRecord, now: Date): void => {
  const keepMs = record.recording?.keep_ms ?? target.record?.keepMs;
  if (keepMs === undefined) return;
  const entry = landingFromRecord(target, record);
  appendRetainedJsonl(path.join(target.stateDir, FEED_LANDINGS_FILE), entry, {
    isEntry: isFeedLanding, keepMs, now, timeOf: (landing) => landing.landed_at
  });
};

/** A verified clean host record seeds opt-in history or repairs a previously failed append. */
export const ensureFeedLanding = (target: LandingTarget, record: FeedLandedRecord, now: Date): void => {
  if (!target.record && !record.recording) return;
  const expected = JSON.stringify(landingFromRecord(target, record));
  const history = readFeedLandings(target.stateDir);
  if (history.errors.length) throw new Error(`Cannot reconcile feed history: ${history.errors.join("; ")}`);
  if (JSON.stringify(history.entries.at(-1)) === expected) {
    syncFileSync(path.join(target.stateDir, FEED_LANDINGS_FILE));
    return;
  }
  // Also covers recovery after a previous host-record directory fsync failed.
  syncFileSync(path.join(target.stateDir, "landed.json"));
  appendFeedLanding(target, record, now);
};

/** Reconcile the authoritative predecessor before ANY replacement, even a revision advance. */
export const publishFeedLanded = (target: FeedTarget, record: FeedLandedRecord, now: Date, previous: FeedLandedRecord | null, switchingAt?: string): FeedLandedRecord => {
  if (previous) ensureFeedLanding(target, previous, now);
  const { recording: _previousRecording, ...next } = record;
  const landing = target.record ? landingFromRecord(target, next) : undefined;
  if (landing) landing.switching_at = switchingAt
    ?? (previous?.identity.landed_at === next.identity.landed_at ? previous.recording?.landing.switching_at : undefined)
    ?? landing.landed_at;
  const published = writeFeedLanded(target.stateDir, target.record ? {
    ...next, recording: { keep_ms: target.record.keepMs, landing: landing! }
  } : next);
  if (target.record) ensureFeedLanding(target, published, now);
  return published;
};
