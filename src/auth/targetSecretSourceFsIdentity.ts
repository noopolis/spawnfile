import { type BigIntStats } from "node:fs";

import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";

// One identity model for the whole auth-owned target-secret store.
//
// The read path and the publish path both re-observe a pathname they already
// stat'ed and must decide whether they are still looking at the same node.
// They used to answer that question differently: the read path compared
// `birthtimeNs` as well, the publish path compared only `dev, ino, mode,
// nlink, uid` (+ `size`). On a filesystem that recycles inode numbers — ext4
// does, freely — the publish path could be handed a *different* file at the
// same `dev, ino` and see no difference at all. This module is the single
// definition both paths now use.
//
// `birthtimeNs` is in every comparator. It is fixed for the life of an inode
// and changes on every reallocation, so it is the discriminator that survives
// inode-number reuse. `ctimeNs` is in `sameFileExact` only: it moves whenever
// the file is legitimately mutated while observed — a cooperating peer
// appending the second half of a record, or the publisher itself touching a
// directory — so putting it anywhere else would reject correct behaviour.
// `sameFileNode` therefore omits `ctimeNs` and `size` for exactly the same
// reason it always omitted `size`.
//
// On a filesystem that does not report a birth time, libuv reports `0n` or the
// ctime for every file, so `birthtimeNs` carries no information and every
// comparison degrades to the behaviour these paths had before this module
// existed. It can never produce a false failure, only fail to add one.
//
// The property this actually buys, stated exactly: any replacement that is not
// byte-, mode-, uid-, and nlink-identical to the original is rejected by the
// content proof that already runs; a byte-identical replacement is rejected as
// well, unless it was created within one kernel tick of the original, in which
// case it is indistinguishable from the original by any stat field and is
// observably harmless. This is not full inode-replacement detection: the
// lstat-then-open window holds no file descriptor pinning the inode, so no
// stat-based scheme can deliver that.

export type DirectoryIdentity = Readonly<{
  birthtimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
}>;

export type FileIdentity = Readonly<{
  birthtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: number;
  uid: bigint;
}>;

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };

/** Validates one mode-`0700` owner-held directory and reduces it to its identity. */
export const directoryIdentityOf = (info: BigIntStats, owner: number): DirectoryIdentity => {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(owner) || (info.mode & 0o7777n) !== 0o700n) fail();
  return { birthtimeNs: info.birthtimeNs, dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid };
};

/** Validates one mode-`0600` owner-held regular file and reduces it to its identity. */
export const fileIdentityOf = (
  info: BigIntStats, owner: number, links: readonly number[], maxBytes: number, zero = false
): FileIdentity => {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== BigInt(owner)
    || !links.some((link) => info.nlink === BigInt(link)) || (info.mode & 0o7777n) !== 0o600n
    || info.size < 0n || info.size > BigInt(maxBytes) || (zero && info.size !== 0n)) fail();
  return {
    birthtimeNs: info.birthtimeNs, ctimeNs: info.ctimeNs, dev: info.dev, ino: info.ino,
    mode: info.mode, nlink: info.nlink, size: Number(info.size), uid: info.uid
  };
};

/**
 * Same directory node. Never compares ctime: the publisher mutates the leaf
 * directory's ctime itself every time it links or unlinks an election name.
 */
export const sameDirectory = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.birthtimeNs === right.birthtimeNs && left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid;

/** Same file, unchanged in every observable field including ctime and size. */
export const sameFileExact = (left: FileIdentity, right: FileIdentity): boolean =>
  left.birthtimeNs === right.birthtimeNs && left.ctimeNs === right.ctimeNs && left.dev === right.dev
  && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
  && left.size === right.size && left.uid === right.uid;

/**
 * Same file node, allowing the size and ctime to move. This is the growing
 * final: an identical writer may legitimately append the rest of the record
 * between two observations, which changes both.
 */
export const sameFileNode = (left: FileIdentity, right: FileIdentity): boolean =>
  left.birthtimeNs === right.birthtimeNs && left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid;

/**
 * Same inode, allowing the link count and ctime to move. This is the zero-byte
 * token or claim while an identical publisher links or unlinks the other name.
 */
export const sameFileInode = (left: FileIdentity, right: FileIdentity): boolean =>
  left.birthtimeNs === right.birthtimeNs && left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.size === right.size && left.uid === right.uid;
