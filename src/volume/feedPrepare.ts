// `include` and `prepare`: what a feed adds to the source in staging, before validation and freeze.
//
// THE REVISION DESCRIBES WHAT IS SERVED. With either declared, the revision is the digest of the source
// revision, every included directory's digest and the prepare recipe (command, image digest, platform,
// network), so it is decided WITHOUT running anything: an unchanged refresh compares digests and lands
// nothing. The prepare output itself is not hashed into the revision (an install is not byte-reproducible
// across registries and time); it is hashed into the land-time manifest like every other tree, so verify
// still catches any change after landing.
//
// WHY A PINNED IMAGE. Native modules are built for the platform that installs them; installing on the
// host would serve host binaries to containers on another libc or arch. A digest-pinned image on the
// target platform is the same rule the `dependencies` bundle follows. `host: true` is the explicit
// opt-out for steps that are platform-neutral (copying assets).
//
// WHY A CACHE. A heal re-lands the same revision from the source; without a cache that is a full
// reinstall at the moment the volume is under attack. The cache is keyed by the revision (which already
// covers tree + recipe + image + platform), lives in host state, and is re-verified by digest on every use.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { containerArgv } from "../compiler/workspaceBundleRun.js";

import { feedError, removeTree } from "./feedLayout.js";
import { sha256Hex } from "./feedManifest.js";
import {
  digestDirectory, resolveFeedSource, stageFeedSource, type FeedExec, type FeedPreparedProvenance, type ResolvedFeedSource
} from "./feedSource.js";
import { feedPreparedDir, type FeedTarget } from "./feedTarget.js";

const PREPARE_CACHE_KEEP = 2;
const CONTAINER_TREE = "/spawnfile/feed";

const preparedOf = (target: FeedTarget): boolean => target.include !== undefined || target.prepare !== undefined;

const prepareRecipe = (target: FeedTarget): FeedPreparedProvenance["prepare"] => {
  const prepare = target.prepare;
  if (!prepare) return null;
  return prepare.kind === "image"
    ? { command: prepare.command, image: prepare.image, network: prepare.network, platform: prepare.platform }
    : { command: prepare.command, image: null, network: null, platform: null };
};

const compose = (target: FeedTarget, source: ResolvedFeedSource, include: FeedPreparedProvenance["include"]): ResolvedFeedSource => {
  const prepared: FeedPreparedProvenance = { include, prepare: prepareRecipe(target), source_revision: source.revision };
  return { provenance: { ...source.provenance, prepared }, revision: sha256Hex(`prepared\n${JSON.stringify(prepared)}\n`) };
};

const includeDigest = (from: string): string => {
  let stat;
  try { stat = lstatSync(from); } catch { throw feedError(`feed include directory ${from} does not exist`); }
  if (!stat.isDirectory()) throw feedError(`feed include ${from} is not a directory`);
  return digestDirectory(from);
};

/** The source revision, composed with `include` and `prepare` when the feed declares them. */
export const resolveFeedContent = (target: FeedTarget, { exec }: { exec: FeedExec }): ResolvedFeedSource => {
  const source = resolveFeedSource(target.source, { exec });
  if (!preparedOf(target)) return source;
  return compose(target, source, (target.include ?? []).map(({ from, to }) => ({ digest: includeDigest(from), to })));
};

/** The source half of a composed revision, which is what staging the source must reproduce. */
const sourcePart = (resolved: ResolvedFeedSource): ResolvedFeedSource => {
  const { prepared, ...provenance } = resolved.provenance;
  return { provenance, revision: prepared?.source_revision ?? resolved.revision };
};

/** Every component of `to` below the staged root must be absent or a real directory: never follow a staged symlink out. */
const stageInclude = (stagingDir: string, from: string, to: string): string => {
  let parent = stagingDir;
  const segments = to.split("/");
  for (const [index, segment] of segments.entries()) {
    const next = path.join(parent, segment);
    let stat;
    try { stat = lstatSync(next); } catch { stat = null; }
    if (index === segments.length - 1) {
      if (stat) throw feedError(`feed include target ${to} already exists in the fed tree; an include adds files, it never replaces them`);
    } else if (stat && !stat.isDirectory()) {
      throw feedError(`feed include target ${to} passes through ${segments.slice(0, index + 1).join("/")}, which is not a directory in the fed tree`);
    } else if (!stat) mkdirSync(next);
    parent = next;
  }
  const destination = path.join(stagingDir, to);
  cpSync(from, destination, { errorOnExist: true, force: false, preserveTimestamps: true, recursive: true, verbatimSymlinks: true });
  return digestDirectory(destination);
};

const failure = (result: ReturnType<typeof spawnSync>, timeoutMs: number): string | null => {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return `did not finish within ${Math.round(timeoutMs / 1000)}s and was killed`;
  if (result.error) return `could not run: ${result.error.message}`;
  if (result.status === 0) return null;
  const output = `${String(result.stderr ?? "")}${String(result.stdout ?? "")}`.trim().split("\n").slice(-20).join("\n");
  return `${result.signal ? `was killed by ${result.signal}` : `exited ${result.status}`}${output ? `:\n${output}` : ""}`;
};

/** Runs the declared prepare step in the staged tree; any failure lands nothing. */
export const runFeedPrepare = (target: FeedTarget, tree: string, resolved: ResolvedFeedSource): void => {
  const prepare = target.prepare;
  if (!prepare) return;
  const env = { SPAWNFILE_FEED_RESOURCE: target.resourceId, SPAWNFILE_FEED_REVISION: resolved.revision };
  const spawnOptions = { encoding: "utf8" as const, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], timeout: prepare.timeoutMs };
  let result;
  if (prepare.kind === "host") {
    const [file, ...args] = prepare.command;
    result = spawnSync(file as string, args, { ...spawnOptions, cwd: tree, env: { ...process.env, ...env, SPAWNFILE_FEED_TREE: tree } });
  } else {
    const name = `spawnfile-feed-${randomBytes(8).toString("hex")}`;
    const [file, ...args] = containerArgv({
      argv: prepare.command, dockerCommand: prepare.dockerCommand, env: { ...env, SPAWNFILE_FEED_TREE: CONTAINER_TREE }, image: prepare.image,
      mounts: [[tree, CONTAINER_TREE]], name, network: prepare.network, platform: prepare.platform, workdir: CONTAINER_TREE
    });
    result = spawnSync(file as string, args, spawnOptions);
    // A killed client can leave its container running: remove it, bounded, before reporting.
    if (result.status !== 0) spawnSync(prepare.dockerCommand, ["rm", "--force", name], { stdio: "ignore", timeout: 30_000 });
  }
  const why = failure(result, prepare.timeoutMs);
  if (why) throw feedError(`the feed prepare command for ${target.resourceId} ${why}; nothing was landed`);
  if (readdirSync(tree).length === 0) throw feedError(`the feed prepare command for ${target.resourceId} left an empty tree; a fed volume never serves nothing`);
};

const cachePaths = (target: FeedTarget, revision: string): { marker: string; tree: string } =>
  ({ marker: path.join(feedPreparedDir(target), `${revision}.json`), tree: path.join(feedPreparedDir(target), revision) });

/** Copies a cached prepared tree into staging; true only when the copy's digest is the one recorded at store time. */
const restoreCached = (target: FeedTarget, revision: string, stagingDir: string, log: (line: string) => void): boolean => {
  const { marker, tree } = cachePaths(target, revision);
  let digest: unknown;
  try { digest = (JSON.parse(readFileSync(marker, "utf8")) as { digest?: unknown }).digest; } catch { return false; }
  try {
    if (!lstatSync(tree).isDirectory()) return false;
    cpSync(tree, stagingDir, { errorOnExist: true, force: false, preserveTimestamps: true, recursive: true, verbatimSymlinks: true });
    if (digestDirectory(stagingDir) === digest) { log(`reused the prepared tree for ${revision.slice(0, 12)} from the cache`); return true; }
  } catch { /* fall through to a fresh build */ }
  log(`the cached prepared tree for ${revision.slice(0, 12)} no longer matches its digest; preparing it again`);
  removeTree(tree, { volume: target.volume });
  rmSync(marker, { force: true });
  removeTree(stagingDir, { volume: target.volume });
  mkdirSync(stagingDir);
  return false;
};

/** Best-effort: a cache that cannot be written costs a reinstall later, never this landing. */
const storeCached = (target: FeedTarget, revision: string, stagingDir: string, log: (line: string) => void): void => {
  const directory = feedPreparedDir(target), { marker, tree } = cachePaths(target, revision);
  const tmp = `${tree}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    removeTree(tmp, { volume: target.volume });
    cpSync(stagingDir, tmp, { errorOnExist: true, force: false, preserveTimestamps: true, recursive: true, verbatimSymlinks: true });
    const digest = digestDirectory(tmp);
    removeTree(tree, { volume: target.volume });
    renameSync(tmp, tree);
    writeFileSync(`${marker}.tmp`, `${JSON.stringify({ digest, revision })}\n`, { mode: 0o600 });
    renameSync(`${marker}.tmp`, marker);
    const entries = readdirSync(directory).filter((name) => name.endsWith(".json"))
      .map((name) => ({ name: name.slice(0, -".json".length), time: statSync(path.join(directory, name)).mtimeMs }))
      .sort((left, right) => right.time - left.time);
    for (const stale of entries.slice(PREPARE_CACHE_KEEP)) {
      rmSync(path.join(directory, `${stale.name}.json`), { force: true });
      removeTree(path.join(directory, stale.name), { volume: target.volume });
    }
  } catch (error) {
    try { removeTree(tmp, { volume: target.volume }); } catch { /* reported below */ }
    log(`could not cache the prepared tree for ${revision.slice(0, 12)}: ${(error as Error).message}`);
  }
};

/**
 * Stages the source, then the includes, then runs prepare, in `stagingDir` (existing, empty). Returns the
 * revision of what was actually staged: a source or include edited mid-copy lands under its own revision.
 */
export const stageFeedContent = (
  target: FeedTarget,
  resolved: ResolvedFeedSource,
  stagingDir: string,
  { exec, log }: { exec: FeedExec; log: (line: string) => void }
): ResolvedFeedSource => {
  if (!preparedOf(target)) return stageFeedSource(target.source, resolved, stagingDir, { exec });
  if (target.prepare && restoreCached(target, resolved.revision, stagingDir, log)) return resolved;
  const source = stageFeedSource(target.source, sourcePart(resolved), stagingDir, { exec });
  const staged = compose(target, source, (target.include ?? []).map(({ from, to }) => ({ digest: stageInclude(stagingDir, from, to), to })));
  if (target.prepare) {
    log(`preparing ${staged.revision.slice(0, 12)}: ${target.prepare.command.join(" ")}${target.prepare.kind === "image" ? ` in ${target.prepare.image} (${target.prepare.platform})` : " on the host"}`);
    runFeedPrepare(target, stagingDir, staged);
    storeCached(target, staged.revision, stagingDir, log);
  }
  return staged;
};
