import type { BigIntStats } from "node:fs";
import { describe, expect, it } from "vitest";

import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";
import {
  directoryIdentityOf, fileIdentityOf, sameDirectory, sameFileExact, sameFileInode, sameFileNode
} from "./targetSecretSourceFsIdentity.js";

// These pairs are synthetic on purpose. The identity model must be provable
// without depending on whether the host filesystem recycles inode numbers,
// reports a birth time, or ticks its clock coarsely: those are exactly the
// properties that made the real-filesystem regression only appear ~35% of the
// time, and only under parallel load.

const owner = 1000;
const MAX = 65_536;

type StatFields = {
  readonly birthtimeNs?: bigint;
  readonly ctimeNs?: bigint;
  readonly dev?: bigint;
  readonly ino?: bigint;
  readonly mode?: bigint;
  readonly nlink?: bigint;
  readonly size?: bigint;
  readonly uid?: bigint;
  readonly directory?: boolean;
  readonly symlink?: boolean;
};

const stats = (fields: StatFields = {}): BigIntStats => ({
  birthtimeNs: 1_000n, ctimeNs: 2_000n, dev: 66n, ino: 4_242n, mode: 0o100600n,
  nlink: 1n, size: 128n, uid: BigInt(owner), ...fields,
  isFile: () => fields.directory !== true,
  isDirectory: () => fields.directory === true,
  isSymbolicLink: () => fields.symlink === true
} as unknown as BigIntStats);

const directoryStats = (fields: StatFields = {}): BigIntStats =>
  stats({ directory: true, mode: 0o40700n, size: 4_096n, nlink: 2n, ...fields });

const file = (fields: StatFields = {}) => fileIdentityOf(stats(fields), owner, [1, 2], MAX);
const directory = (fields: StatFields = {}) => directoryIdentityOf(directoryStats(fields), owner);

describe("targetSecretSourceFsIdentity", () => {
  it("rejects every pair that differs only by birth time", () => {
    const left = file();
    const right = file({ birthtimeNs: 1_001n });
    expect(sameFileExact(left, right)).toBe(false);
    expect(sameFileNode(left, right)).toBe(false);
    expect(sameFileInode(left, right)).toBe(false);

    const leftDirectory = directory();
    const rightDirectory = directory({ birthtimeNs: 1_001n });
    expect(sameDirectory(leftDirectory, rightDirectory)).toBe(false);
  });

  it("accepts a same-inode pair that only grew and re-stamped its ctime", () => {
    const left = file({ ctimeNs: 2_000n, size: 64n });
    const right = file({ ctimeNs: 9_000n, size: 128n });
    expect(sameFileNode(left, right)).toBe(true);
    expect(sameFileExact(left, right)).toBe(false);
  });

  it("accepts a same-inode pair whose link count moved while an election name was linked", () => {
    const left = file({ nlink: 1n });
    const right = file({ nlink: 2n });
    expect(sameFileInode(left, right)).toBe(true);
    expect(sameFileNode(left, right)).toBe(false);
    expect(sameFileExact(left, right)).toBe(false);
  });

  it("accepts identical observations and rejects every other single-field difference", () => {
    const base = file();
    expect(sameFileExact(base, file())).toBe(true);
    expect(sameFileNode(base, file())).toBe(true);
    expect(sameFileInode(base, file())).toBe(true);
    expect(sameDirectory(directory(), directory())).toBe(true);

    for (const changed of [{ dev: 67n }, { ino: 4_243n }, { mode: 0o100400n }, { uid: BigInt(owner + 1) }]) {
      const drifted = { ...base, ...changed };
      expect(sameFileExact(base, drifted)).toBe(false);
      expect(sameFileNode(base, drifted)).toBe(false);
      expect(sameFileInode(base, drifted)).toBe(false);
      expect(sameDirectory(directory(), { ...directory(), ...changed })).toBe(false);
    }
    expect(sameFileInode(base, file({ size: 64n }))).toBe(false);
    expect(sameFileExact(base, file({ ctimeNs: 3_000n }))).toBe(false);
  });

  it("carries the validation the two call sites already required", () => {
    expect(file().size).toBe(128);
    expect(fileIdentityOf(stats({ size: 0n }), owner, [1], MAX, true).size).toBe(0);
    expect(() => fileIdentityOf(stats({ directory: true }), owner, [1], MAX)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => fileIdentityOf(stats({ symlink: true }), owner, [1], MAX)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => fileIdentityOf(stats(), owner + 1, [1], MAX)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => fileIdentityOf(stats({ nlink: 2n }), owner, [1], MAX)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => fileIdentityOf(stats({ mode: 0o100644n }), owner, [1], MAX)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => fileIdentityOf(stats({ size: -1n }), owner, [1], MAX)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => fileIdentityOf(stats({ size: BigInt(MAX) + 1n }), owner, [1], MAX)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => fileIdentityOf(stats({ size: 1n }), owner, [1], MAX, true)).toThrow(TARGET_SECRET_SOURCE_ERROR);

    expect(directory().mode).toBe(0o40700n);
    expect(() => directoryIdentityOf(stats(), owner)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => directoryIdentityOf(directoryStats({ symlink: true }), owner)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => directoryIdentityOf(directoryStats(), owner + 1)).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => directoryIdentityOf(directoryStats({ mode: 0o40755n }), owner)).toThrow(TARGET_SECRET_SOURCE_ERROR);
  });
});
