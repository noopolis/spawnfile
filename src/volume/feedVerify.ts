// Integrity of a fed volume, judged only against the host's own record and manifest.
//
// `drift` is repairable from the source (the tree is gone or its content moved); `relink` and `identity`
// are repairable in place. A real file or directory where the host's link or tree belongs is NOT
// repairable without deleting a name the host did not write, which it never does: those findings
// carry the one command an operator runs to clear them.

import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

import {
  FEED_CURRENT_LINK, FEED_IDENTITY_FILE, FEED_TREES_DIR, assertRealDirectory, auditFeedRoot, feedTreeLink,
  moveAsideCommand, treeShape
} from "./feedLayout.js";
import { compareFeedManifest, manifestDrift, readFeedManifest, sha256Hex } from "./feedManifest.js";
import { readFeedIdentityBytes, type FeedLandedRecord } from "./feedRecord.js";
import type { FeedTarget } from "./feedTarget.js";

export interface FeedSweep {
  blocked: boolean;
  drift: boolean;
  failed: boolean;
  findings: string[];
  identity: "forged" | "missing" | null;
  planted: boolean;
  relink: boolean;
  touched: string[];
  unknown: string[];
}

const readLink = (file: string): string => {
  const shape = treeShape(file);
  if (shape === "missing") return "missing";
  if (shape !== "symlink") return "not a symlink";
  try { return readlinkSync(file); } catch { return "missing"; }
};

const sweepVolume = (target: FeedTarget, record: FeedLandedRecord): FeedSweep => {
  const result: FeedSweep = { blocked: false, drift: false, failed: false, findings: [], identity: null, planted: false, relink: false, touched: [], unknown: [] };
  const volume = target.volume;
  result.unknown.push(...auditFeedRoot(volume));

  const treesDir = path.join(volume, FEED_TREES_DIR);
  const treesPresent = assertRealDirectory(treesDir, "the fed volume's trees/ directory");
  if (treesPresent) {
    for (const name of readdirSync(treesDir).sort()) {
      if (!record.trees.includes(name)) result.unknown.push(`${FEED_TREES_DIR}/${name} is not a tree this host landed`);
    }
  }

  const treePath = path.join(volume, feedTreeLink(record.tree));
  const shape = treesPresent ? treeShape(treePath) : "missing";
  if (shape === "missing") {
    result.drift = true;
    result.findings.push(`${feedTreeLink(record.tree)} is gone from the volume; it must be re-landed`);
  } else if (shape !== "directory") {
    result.planted = true;
    result.findings.push(`${feedTreeLink(record.tree)} is a ${shape} where the host's tree belongs; clear it with: ${moveAsideCommand(volume, treePath)}`);
  } else {
    const manifest = readFeedManifest(target.stateDir, record.tree);
    if (!manifest) { result.drift = true; result.findings.push(`no land-time manifest for ${record.revision.slice(0, 12)}, so its content cannot be verified`); }
    else {
      const compared = compareFeedManifest(treePath, manifest);
      const drift = manifestDrift(compared);
      // The tree root itself is frozen at land; an owner restoring its write bit can add names to it.
      if ((lstatSync(treePath).mode & 0o777) !== 0o555) drift.push(". changed");
      if (drift.length) {
        result.drift = true;
        result.findings.push(`${feedTreeLink(record.tree).slice(0, 18)} no longer matches what the host landed: ${drift.slice(0, 8).join(", ")}${drift.length > 8 ? ` and ${drift.length - 8} more` : ""}`);
      }
      result.touched = compared.touched;
    }
  }

  const live = path.join(volume, FEED_CURRENT_LINK);
  const link = readLink(live), want = feedTreeLink(record.tree);
  if (link !== want) {
    if (link === "not a symlink") {
      result.blocked = true;
      result.findings.push(`${FEED_CURRENT_LINK} is a real entry, not the host's link; clear it with: ${moveAsideCommand(volume, live)}`);
    } else {
      result.relink = true;
      result.findings.push(`${FEED_CURRENT_LINK} is ${link === "missing" ? "missing" : `-> ${link}`}, want -> ${want}`);
    }
  }

  const bytes = readFeedIdentityBytes(volume);
  if (bytes === null) { result.identity = "missing"; result.findings.push(`${FEED_IDENTITY_FILE} is gone`); }
  else if (sha256Hex(bytes) !== record.identity_sha256) { result.identity = "forged"; result.findings.push(`${FEED_IDENTITY_FILE} is not the record this host published`); }

  result.findings.push(...result.unknown);
  return result;
};

/**
 * NO EXCEPTION LEAVES THIS SWEEP WITHOUT A FINDING. A sweep that throws is a volume nothing verified,
 * and it must read as "not clean", never as a quiet exit.
 */
export const sweepFeed = (target: FeedTarget, record: FeedLandedRecord): FeedSweep => {
  try { return sweepVolume(target, record); }
  catch (error) {
    return {
      blocked: false, drift: false, failed: true, identity: null, planted: false, relink: false, touched: [], unknown: [],
      findings: [`the integrity sweep could not complete, so nothing in this volume is verified: ${String((error as Error).message).split("\n")[0]}`]
    };
  }
};
