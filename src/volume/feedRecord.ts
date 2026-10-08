// Two records, kept apart on purpose:
//
//   * the HOST record (`<state>/landed.json`), outside the volume: the only input the host decides from;
//   * the IDENTITY record (`<volume>/.spawnfile-feed.json`), inside the volume: an OUTPUT for agents to
//     read. The agent uid can replace that name, so the host takes no decision from it -- it reads it back
//     only to compare its digest with the one the host recorded, which is a tamper check, not trust.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, lchownSync } from "node:fs";
import path from "node:path";

import { FEED_IDENTITY_FILE, feedError, feedTreeLink } from "./feedLayout.js";
import { sha256Hex } from "./feedManifest.js";
import type { FeedProvenance } from "./feedSource.js";

export const FEED_LANDED_VERSION = "spawnfile.volume-feed-landed.v1";
export const FEED_IDENTITY_VERSION = "spawnfile.volume-feed.v1";

const REVISION = /^[0-9a-f]{64}$/u;
/** A physical tree name: the revision, or the revision plus a generation for a re-land beside a drifted copy. */
const TREE_NAME = /^[0-9a-f]{64}(?:\.[1-9][0-9]*)?$/u;

export interface FeedIdentity {
  files: number;
  landed_at: string;
  resource: string;
  revision: string;
  source: FeedProvenance;
  tree: string;
  version: typeof FEED_IDENTITY_VERSION;
  volume: string;
}

export interface FeedLandedRecord {
  /** Re-land cycles per revision since the volume was last clean; a ceiling suspends auto-repair. */
  heals: Record<string, number>;
  identity: FeedIdentity;
  identity_sha256: string;
  revision: string;
  /** Physical name of the serving tree under trees/. */
  tree: string;
  /** Recorded tree names in serving order, the serving tree last. */
  trees: string[];
  version: typeof FEED_LANDED_VERSION;
}

export const isFeedRevision = (value: unknown): value is string => typeof value === "string" && REVISION.test(value);
export const isFeedTreeName = (value: unknown): value is string => typeof value === "string" && TREE_NAME.test(value);

export const feedIdentityFindings = (record: unknown): string[] => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["must be a JSON object"];
  const value = record as Partial<FeedIdentity>, findings: string[] = [];
  if (value.version !== FEED_IDENTITY_VERSION) findings.push(`version must be ${FEED_IDENTITY_VERSION}`);
  if (!isFeedRevision(value.revision)) findings.push("revision must be a 64-character hex digest");
  else if (typeof value.tree !== "string" || !value.tree.startsWith(`${feedTreeLink(value.revision)}`) || !isFeedTreeName(value.tree.slice("trees/".length))) findings.push(`tree must be ${feedTreeLink(value.revision)}[.<generation>]`);
  if (typeof value.resource !== "string" || !value.resource) findings.push("resource must name the volume resource");
  if (typeof value.volume !== "string" || !value.volume) findings.push("volume must name the host volume");
  if (!Number.isInteger(value.files) || (value.files as number) < 0) findings.push("files must be a count");
  if (typeof value.landed_at !== "string" || !value.landed_at) findings.push("landed_at must be an instant");
  if (!value.source || typeof value.source !== "object" || !["git", "directory"].includes(value.source.kind)) findings.push("source must describe a git or directory source");
  return findings;
};

export const feedLandedFindings = (record: unknown): string[] => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["must be a JSON object"];
  const value = record as Partial<FeedLandedRecord>, findings: string[] = [];
  if (value.version !== FEED_LANDED_VERSION) findings.push(`version must be ${FEED_LANDED_VERSION}`);
  if (!isFeedRevision(value.revision)) findings.push("revision must be a 64-character hex digest");
  if (!isFeedTreeName(value.tree) || (isFeedRevision(value.revision) && value.tree.slice(0, 64) !== value.revision)) findings.push("tree must name a tree of the serving revision");
  if (!Array.isArray(value.trees) || value.trees.some((tree) => !isFeedTreeName(tree))) findings.push("trees must list landed tree names");
  else if (value.trees.at(-1) !== value.tree) findings.push("trees must end with the serving tree");
  if (typeof value.identity_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.identity_sha256)) findings.push("identity_sha256 must be a hex digest");
  findings.push(...feedIdentityFindings(value.identity).map((finding) => `identity ${finding}`));
  if (value.identity && (value.identity.revision !== value.revision || value.identity.tree !== `trees/${value.tree}`)) findings.push("identity must describe the serving tree");
  if (!value.heals || typeof value.heals !== "object" || Array.isArray(value.heals)) findings.push("heals must be an object");
  return findings;
};

const landedPath = (stateDir: string): string => path.join(stateDir, "landed.json");

/** Findings, not a throw: a corrupt record degrades to "nothing landed" and is re-earned by a full land. */
export const readFeedLanded = (stateDir: string): { reason: string | null; record: FeedLandedRecord | null } => {
  let text;
  try { text = readFileSync(landedPath(stateDir), "utf8"); } catch { return { reason: null, record: null }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { reason: "landed.json is not parseable JSON", record: null }; }
  const findings = feedLandedFindings(parsed);
  return findings.length ? { reason: `landed.json is invalid: ${findings.join("; ")}`, record: null } : { reason: null, record: parsed as FeedLandedRecord };
};

/** tmp + rename, 0600, and only ever after the volume mutation it describes has succeeded. */
export const writeFeedLanded = (stateDir: string, record: FeedLandedRecord): FeedLandedRecord => {
  const findings = feedLandedFindings(record);
  if (findings.length) throw feedError(`refusing to write an invalid landed.json: ${findings.join("; ")}`);
  mkdirSync(stateDir, { mode: 0o700, recursive: true });
  const file = landedPath(stateDir), tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return record;
};

export const feedIdentityBytes = (record: FeedIdentity): string => `${JSON.stringify(record, null, 2)}\n`;

/**
 * Validated after it is on disk and before it is visible -- reparsing what the filesystem holds is what
 * catches a truncated write -- then moved into the volume with one rename. The temporary file lives in
 * `tmpDir`, outside the volume, so the volume root never gains a transient entry.
 */
export const writeFeedIdentity = (volume: string, record: FeedIdentity, { owner, tmpDir }: { owner?: string; tmpDir: string }): string => {
  const planned = feedIdentityFindings(record);
  if (planned.length) throw feedError(`refusing to publish an invalid ${FEED_IDENTITY_FILE}: ${planned.join("; ")}`);
  const tmp = path.join(tmpDir, `${FEED_IDENTITY_FILE}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  const bytes = feedIdentityBytes(record);
  writeFileSync(tmp, bytes, { mode: 0o444 });
  let written: unknown = null;
  try { written = JSON.parse(readFileSync(tmp, "utf8")); } catch { /* reported below */ }
  const findings = written === null ? ["did not survive the write as JSON"] : feedIdentityFindings(written);
  if (findings.length) { rmSync(tmp, { force: true }); throw feedError(`${FEED_IDENTITY_FILE} failed validation after it was written: ${findings.join("; ")}`); }
  if (owner) { const [uid, gid] = owner.split(":").map(Number); lchownSync(tmp, uid, gid); }
  chmodSync(tmp, 0o444);
  renameSync(tmp, path.join(volume, FEED_IDENTITY_FILE));
  return sha256Hex(bytes);
};

export const readFeedIdentityBytes = (volume: string): string | null => {
  try { return readFileSync(path.join(volume, FEED_IDENTITY_FILE), "utf8"); } catch { return null; }
};
