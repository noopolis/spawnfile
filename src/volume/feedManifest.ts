// The land-time manifest of a fed tree: what the host put there, kept OUTSIDE the volume.
//
// WHY VERIFY INSTEAD OF PREVENT: the mount stays mutable (the container owns the volume root), and an
// owner can always restore its own write bit, so nothing on the host can make the landed tree
// tamper-proof. The honest guarantee is "cannot be changed unnoticed for longer than one refresh".
//
// WHAT IS CHEAP ENOUGH TO RUN EVERY FEW MINUTES: one lstat per entry, compared with the (kind, size,
// mtime, mode) recorded at land time. A same-size rewrite shows up only as a moved mtime, so exactly
// those files -- and no others -- are hashed and compared with the digest recorded at land time.
// Every walk here uses lstat and never descends a symlink: an agent can plant one.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FEED_MANIFEST_VERSION = "spawnfile.volume-feed-manifest.v1";

export type FeedManifestEntry =
  | ["d", number]
  | ["f", number, number, number, string]
  | ["l", string];

export interface FeedManifest {
  entries: Record<string, FeedManifestEntry>;
  files: number;
  revision: string;
  version: typeof FEED_MANIFEST_VERSION;
}

export interface FeedManifestComparison {
  changed: string[];
  extra: string[];
  missing: string[];
  touched: string[];
}

export const sha256Hex = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const fileDigest = (file: string): string => sha256Hex(readFileSync(file));

type Shape = ["d", number] | ["f", number, number, number] | ["l", string];

const walkShapes = (root: string): Map<string, Shape> => {
  const shapes = new Map<string, Shape>();
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name), key = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) shapes.set(key, ["l", readlinkSync(full)]);
      else if (stat.isDirectory()) { shapes.set(key, ["d", mode]); walk(full, key); }
      else shapes.set(key, ["f", stat.size, Math.round(stat.mtimeMs), mode]);
    }
  };
  walk(root, "");
  return shapes;
};

/** Built from the frozen staged tree, so it records exactly the modes and bytes that land. */
export const buildFeedManifest = (root: string, revision: string): FeedManifest => {
  const entries: Record<string, FeedManifestEntry> = {};
  let files = 0;
  for (const [key, shape] of walkShapes(root)) {
    if (shape[0] === "f") { entries[key] = [...shape, fileDigest(path.join(root, key))]; files += 1; }
    else entries[key] = shape;
  }
  return { entries, files, revision, version: FEED_MANIFEST_VERSION };
};

/**
 * `changed` is drift on its own evidence (kind, size, mode, link target, or a same-size rewrite whose
 * digest moved); `touched` is a file whose mtime moved while its bytes did not.
 */
export const compareFeedManifest = (root: string, manifest: FeedManifest): FeedManifestComparison => {
  const actual = walkShapes(root);
  const result: FeedManifestComparison = { changed: [], extra: [], missing: [], touched: [] };
  for (const [key, want] of Object.entries(manifest.entries)) {
    const got = actual.get(key);
    if (!got) { result.missing.push(key); continue; }
    if (got[0] !== want[0]) { result.changed.push(key); continue; }
    if (want[0] === "l") { if (got[1] !== want[1]) result.changed.push(key); continue; }
    if (want[0] === "d") { if (got[1] !== want[1]) result.changed.push(key); continue; }
    const file = got as ["f", number, number, number];
    if (file[1] !== want[1] || file[3] !== want[3]) { result.changed.push(key); continue; }
    if (file[2] !== want[2]) {
      let digest: string | null = null;
      try { digest = fileDigest(path.join(root, key)); } catch { /* unreadable is drift */ }
      (digest === want[4] ? result.touched : result.changed).push(key);
    }
  }
  for (const key of actual.keys()) if (!(key in manifest.entries)) result.extra.push(key);
  return result;
};

export const manifestDrift = (comparison: FeedManifestComparison): string[] => [
  ...comparison.missing.map((key) => `${key} missing`),
  ...comparison.extra.map((key) => `${key} added`),
  ...comparison.changed.map((key) => `${key} changed`)
];

const manifestPath = (stateDir: string, revision: string): string => path.join(stateDir, "manifests", `${revision}.json`);

export const writeFeedManifest = (stateDir: string, manifest: FeedManifest): void => {
  const file = manifestPath(stateDir, manifest.revision);
  mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
};

export const readFeedManifest = (stateDir: string, revision: string): FeedManifest | null => {
  try {
    const value = JSON.parse(readFileSync(manifestPath(stateDir, revision), "utf8")) as FeedManifest;
    return value?.version === FEED_MANIFEST_VERSION && value.revision === revision && value.entries ? value : null;
  } catch { return null; }
};

export const removeFeedManifest = (stateDir: string, revision: string): void => {
  rmSync(manifestPath(stateDir, revision), { force: true });
};
