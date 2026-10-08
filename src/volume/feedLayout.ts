// The physical layout of a fed volume, and every rule about what the host writer may touch inside it.
//
// WHY THESE RULES ARE NOT NEGOTIABLE
// ----------------------------------
// A fed volume is mounted into running agents, and the container's start guard inspects the volume
// root on every start: the root must stay mode 0755 and `.spawnfile-resource-identity` must stay exactly
// the bytes, owner and mode the container wrote. Readers inside the agents never pause for a refresh.
// So a host writer can break every agent without writing a byte an agent reads:
//
//   * a partially copied tree, or a tree mid-delete, inside the volume -> a reader (or the start
//     guard) lists an entry that is gone by the time it is opened;
//   * a recursive chown/chmod aimed at the volume root -> the identity sentinel changes -> the next
//     container start refuses the volume;
//   * the root's own mode moved off 0755 -> the start guard refuses the volume.
//
// Hence the shape every function here enforces: content is staged OUTSIDE the volume, enters it through
// exactly one rename(2), becomes visible through one rename(2) of the `current` link, leaves it through
// exactly one rename(2), and is deleted outside it. No recursive mode or ownership change is ever aimed
// at anything but a tree the host still holds privately.
//
//     <state>/staging/<revision>-<pid>/   copied, validated, owned, frozen here
//         |  rename(2)
//     <volume>/trees/<revision>/          immutable content, never rewritten in place
//     <volume>/current -> trees/<revision>   rename(2) over the old link
//     <volume>/.spawnfile-feed.json       which revision `current` serves
//         |  rename(2)
//     <state>/trash/<revision>-<stamp>/   deleted out here, never inside the volume
//
// The volume root stays writable by the agent uid (the container chowns it on start), so the host never
// takes a decision from a name inside the volume: every path it is about to touch is lstat'd and refused
// unless it is the real directory the host created.

import {
  chmodSync, lchownSync, lstatSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

import { SpawnfileError } from "../shared/index.js";

export const FEED_TREES_DIR = "trees";
export const FEED_CURRENT_LINK = "current";
export const FEED_IDENTITY_FILE = ".spawnfile-feed.json";
export const VOLUME_RESOURCE_SENTINEL = ".spawnfile-resource-identity";
export const VOLUME_ROOT_MODE = 0o755;
/** Every name the host itself ever writes at the volume root, plus the container's own sentinel. */
export const FEED_ROOT_NAMES = Object.freeze([VOLUME_RESOURCE_SENTINEL, FEED_IDENTITY_FILE, FEED_TREES_DIR, FEED_CURRENT_LINK]);

export const feedError = (message: string): SpawnfileError => new SpawnfileError("runtime_error", message);
const fail = (message: string): never => { throw feedError(message); };

export const feedTreeLink = (revision: string): string => `${FEED_TREES_DIR}/${revision}`;

const readlinkOrNull = (target: string): string | null => { try { return readlinkSync(target); } catch { return null; } };
/** Resolved through symlinks even when the leaf does not exist yet: the nearest existing ancestor is realpath'd. */
const canonical = (target: string): string => {
  const absolute = path.resolve(target);
  try { return realpathSync(absolute); } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
  }
};

/** Read before any write, and a refusal rather than a repair: the start guard owns that contract. */
export const assertFeedVolumeRoot = (volume: string): void => {
  let stat;
  try { stat = statSync(volume); } catch { return fail(`fed volume ${volume} does not exist; deploy the organization once so the volume is created`); }
  if (!stat.isDirectory()) fail(`fed volume ${volume} is not a directory`);
  const mode = stat.mode & 0o7777;
  if (mode !== VOLUME_ROOT_MODE) {
    fail(`fed volume root ${volume} is mode 0${mode.toString(8)}, must be 0755: the container start guard refuses any other mode. Repair with: chmod 0755 ${volume}`);
  }
  // The container bootstraps an EMPTY volume and refuses a non-empty one without its sentinel, so content
  // landed before the first start would stop every agent from starting at all.
  let sentinel = null;
  try { sentinel = lstatSync(path.join(volume, VOLUME_RESOURCE_SENTINEL)); } catch { /* reported below */ }
  if (!sentinel?.isFile()) {
    fail(`fed volume ${volume} has no ${VOLUME_RESOURCE_SENTINEL}: start the organization once so the container initializes the volume, then refresh it`);
  }
};

/** Absent is not an error (null); a symlink or file where a host directory belongs is a refusal, never a repair. */
export const assertRealDirectory = (target: string, label: string) => {
  let stat;
  try { stat = lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fail(`${label} ${target} is a symlink to ${JSON.stringify(readlinkOrNull(target))}, not a directory; nothing on this host creates it, so the volume was written by something else. Refusing to operate through it.`);
  }
  if (!stat.isDirectory()) fail(`${label} ${target} is not a directory; refusing to operate on it`);
  return stat;
};

/** rename(2) is atomic only within one filesystem; a cross-device "rename" is a copy readers can watch. */
export const assertSameDevice = (volume: string, other: string, label: string): void => {
  const want = statSync(volume).dev, got = statSync(other).dev;
  if (want !== got) fail(`${label} ${other} is on device ${got} but the fed volume ${volume} is on device ${want}; every swap depends on rename(2), which cannot cross filesystems. Put ${label} on the volume's filesystem.`);
};

/** Host state must never live where an agent can write it: it decides what a root-run job deletes. */
export const assertOutsideVolume = (volume: string, target: string, label: string): void => {
  const root = canonical(volume), scope = canonical(target);
  const fromRoot = path.relative(root, scope), toRoot = path.relative(scope, root);
  if (fromRoot === "" || !fromRoot.startsWith("..") || !toRoot.startsWith("..")) {
    fail(`${label} ${scope} overlaps the fed volume ${root}; host state and staging must live outside the volume`);
  }
};

const walkPostOrder = (root: string, visit: (target: string, stat: Stats) => void): void => {
  const walk = (target: string): void => {
    const stat = lstatSync(target);
    if (stat.isDirectory()) for (const name of readdirSync(target).sort()) walk(path.join(target, name));
    visit(target, stat);
  };
  walk(root);
};

/**
 * Ownership and read-only modes for a staged tree, before it is reachable. Never follows a symlink.
 * The top directory stays 0755 so the one rename into the volume works for a non-root writer;
 * `landTree` freezes it the moment it lands.
 */
export const ownAndFreeze = (stagingDir: string, { owner, volume }: { owner?: string; volume: string }): void => {
  assertOutsideVolume(volume, stagingDir, "the staging tree");
  const [uid, gid] = owner ? owner.split(":").map(Number) : [undefined, undefined];
  walkPostOrder(stagingDir, (target, stat) => {
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) fail(`${target} is a special file; a fed volume carries only files, directories and symlinks`);
    if (uid !== undefined && gid !== undefined) lchownSync(target, uid, gid);
    if (stat.isSymbolicLink()) return;
    chmodSync(target, target === stagingDir ? 0o755 : (stat.mode & 0o7777) & ~0o222);
  });
};

/** The one rename that makes a validated tree part of the volume, with its root frozen the moment it lands. */
export const landTree = (stagingDir: string, treePath: string): void => {
  renameSync(stagingDir, treePath);
  chmodSync(treePath, 0o555);
};

/** Every filesystem call the link swap makes, so a test can watch what the swap actually does. */
export const LINK_OPS = Object.freeze({ lstat: lstatSync, readlink: readlinkSync, rename: renameSync, symlink: symlinkSync, unlink: unlinkSync });
export type LinkOps = typeof LINK_OPS;

export const moveAsideCommand = (volume: string, target: string): string =>
  `mv -- ${target} ${path.join(path.dirname(volume), `${path.basename(target)}.planted`)}`;

/**
 * ATOMIC OR NOTHING. The live name is never unlinked: a new link is created under a temporary name outside
 * the volume and rename(2)'d over the live one, so a reader resolving `current` sees the old target or
 * the new one, never a missing name. The target is relative so it resolves the same on the host and at
 * the container mount. Returns false when the link already points at `target`.
 */
export const pointCurrent = (volume: string, target: string, { ops = LINK_OPS, tmpDir }: { ops?: LinkOps; tmpDir: string }): boolean => {
  const live = path.join(volume, FEED_CURRENT_LINK);
  let existing = null;
  try { existing = ops.lstat(live); } catch { /* absent: the first land */ }
  if (existing && !existing.isSymbolicLink()) {
    fail(`${live} is a real ${existing.isDirectory() ? "directory" : "file"}, not the host's link; nothing here deletes a name it did not write. Clear it with: ${moveAsideCommand(volume, live)}`);
  }
  if (existing && ops.readlink(live) === target) return false;
  const tmp = path.join(tmpDir, `.${FEED_CURRENT_LINK}.${process.pid}.tmp`);
  try { ops.unlink(tmp); } catch { /* no leftover from a crashed run */ }
  ops.symlink(target, tmp);
  ops.rename(tmp, live);
  return true;
};

/** Thaw and delete a tree OUTSIDE the volume. A recursive delete is only ever aimed at a real directory. */
export const removeTree = (target: string, { volume }: { volume: string }): void => {
  assertOutsideVolume(volume, target, "the tree being deleted");
  let stat;
  try { stat = lstatSync(target); } catch { return; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) { rmSync(target, { force: true }); return; }
  const thaw = (directory: string): void => {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) thaw(path.join(directory, entry.name));
  };
  thaw(target);
  rmSync(target, { recursive: true, force: true });
};

/** One rename out of the volume. Write on the moved directory is needed to change its parent. */
export const parkTree = (treePath: string, trash: string, stamp: string): string => {
  assertRealDirectory(treePath, "the fed tree being retired");
  const parked = path.join(trash, `${path.basename(treePath)}-${stamp}`);
  chmodSync(treePath, 0o755);
  renameSync(treePath, parked);
  return parked;
};

/** Names at the volume root the host never writes. Reported, never deleted: they are evidence. */
export const auditFeedRoot = (volume: string): string[] => {
  const findings: string[] = [];
  for (const entry of readdirSync(volume, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!FEED_ROOT_NAMES.includes(entry.name)) findings.push(`${entry.name} is a name this host never writes at the volume root`);
  }
  return findings;
};

export const treeShape = (target: string): "missing" | "directory" | "symlink" | "file" => {
  let stat;
  try { stat = lstatSync(target); } catch { return "missing"; }
  return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
};
