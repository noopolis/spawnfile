import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle } from "./targetSecretSourceRecordCommon.js";
import { directoryIdentityOf, fileIdentityOf, sameDirectory, sameFileExact, sameFileInode, sameFileNode, type DirectoryIdentity, type FileIdentity } from "./targetSecretSourceFsIdentity.js";
export type TargetSecretSourceFsPublishImmutablePhase =
  | "after_token_create" | "after_claim_link" | "after_claim_snapshot" | "after_mismatch_snapshot"
  | "after_exact_token_snapshot" | "after_final_create" | "after_partial_write" | "after_file_sync"
  | "before_directory_sync" | "after_directory_sync" | "after_token_cleanup" | "after_claim_cleanup"
  | "after_zero_lstat" | "after_final_lstat" | "after_token_open" | "after_token_sync" | "after_final_open" | "before_unlink_exact"
  | "before_contention_retry";

export interface TargetSecretSourceFsPublishImmutableInput {
  readonly bytes: Uint8Array;
  readonly final_path: string;
  readonly publication_handle: string;
  readonly proveExact: (bytes: Uint8Array) => Promise<void> | void;
}
export interface TargetSecretSourceFsPublishImmutableOptions {
  readonly directory_chain: readonly string[];
  readonly contentionForTest?: (reason: string, attempt: number) => void;
  readonly hookForTest?: (phase: TargetSecretSourceFsPublishImmutablePhase, path: string) => Promise<void> | void;
  readonly maxWriteBytesForTest?: number;
}
export interface TargetSecretSourceFsPublishImmutable {
  publishImmutable(input: TargetSecretSourceFsPublishImmutableInput): Promise<void>;
}

const MAX_BYTES = 65_536;
const MAX_ATTEMPTS = 512;
const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const exists = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "EEXIST";
const ownerUid = (): number => {
  const value = process.getuid?.();
  return typeof value === "number" ? value : fail();
};
const directoryIdentity = (value: BigIntStats, uid: number): DirectoryIdentity => directoryIdentityOf(value, uid);
const fileIdentity = (value: BigIntStats, uid: number, links: readonly number[], zero = false): FileIdentity =>
  fileIdentityOf(value, uid, links, MAX_BYTES, zero);
const contentionDelay = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.min(5, 1 + Math.floor(attempt / 32))));

export const initializeTargetSecretSourceFsPublishImmutable = async (
  options: TargetSecretSourceFsPublishImmutableOptions
): Promise<TargetSecretSourceFsPublishImmutable> => {
  if (!options || typeof options !== "object" || !Array.isArray(options.directory_chain) || options.directory_chain.length < 1
    || options.directory_chain.some((entry) => typeof entry !== "string" || entry.length < 1)) fail();
  const uid = ownerUid();
  const paths = [...options.directory_chain];
  const roots = await Promise.all(paths.map(async (path) => directoryIdentity(await lstat(path, { bigint: true }), uid)));
  const checkChain = async (): Promise<void> => {
    for (let index = 0; index < paths.length; index += 1) {
      const named = directoryIdentity(await lstat(paths[index]!, { bigint: true }), uid);
      if (!sameDirectory(named, roots[index]!)) fail();
      let fd;
      try {
        fd = await open(paths[index]!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const opened = directoryIdentity(await fd.stat({ bigint: true }), uid);
        const after = directoryIdentity(await lstat(paths[index]!, { bigint: true }), uid);
        if (!sameDirectory(opened, roots[index]!) || !sameDirectory(after, roots[index]!)) fail();
      } catch { fail(); } finally { await fd?.close().catch(() => undefined); }
    }
  };
  const syncDirectory = async (): Promise<void> => {
    await checkChain();
    await options.hookForTest?.("before_directory_sync", paths.at(-1)!);
    let fd;
    try {
      fd = await open(paths.at(-1)!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = directoryIdentity(await fd.stat({ bigint: true }), uid);
      if (!sameDirectory(opened, roots.at(-1)!)) fail();
      await fd.sync();
      const after = directoryIdentity(await fd.stat({ bigint: true }), uid);
      const named = directoryIdentity(await lstat(paths.at(-1)!, { bigint: true }), uid);
      if (!sameDirectory(after, roots.at(-1)!) || !sameDirectory(named, roots.at(-1)!)) fail();
    } catch { return fail(); } finally { await fd?.close().catch(() => undefined); }
    await checkChain();
  };
  const snapshotZero = async (path: string, links: readonly number[]): Promise<FileIdentity | null> => {
    await checkChain();
    let before: FileIdentity;
    try {
      const beforeInfo = await lstat(path, { bigint: true });
      if (beforeInfo.nlink === 0n) { fileIdentity(beforeInfo, uid, [0], true); return null; }
      before = fileIdentity(beforeInfo, uid, links, true);
    } catch (error) { if (missing(error)) return null; return fail(); }
    await options.hookForTest?.("after_zero_lstat", path);
    let fd;
    try {
      try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (missing(error)) return null; return fail(); }
      if (!fd) return fail();
      const openedInfo = await fd.stat({ bigint: true });
      if (openedInfo.nlink === 0n) { fileIdentity(openedInfo, uid, [0], true); return null; }
      const opened = fileIdentity(openedInfo, uid, links, true);
      let after: FileIdentity;
      try {
        const afterInfo = await lstat(path, { bigint: true });
        if (afterInfo.nlink === 0n) { fileIdentity(afterInfo, uid, [0], true); return null; }
        after = fileIdentity(afterInfo, uid, links, true);
      } catch (error) { if (missing(error)) return null; return fail(); }
      if (!sameFileInode(before, opened) || !sameFileInode(opened, after) || !sameFileExact(before, opened) || !sameFileExact(opened, after)) return null;
      return opened;
    } catch { return fail(); } finally { await fd?.close().catch(() => undefined); }
  };
  const unlinkExact = async (path: string, expected: FileIdentity): Promise<boolean> => {
    await checkChain();
    const current = await snapshotZero(path, [1, 2]);
    if (current === null || !sameFileInode(current, expected) || !sameFileExact(current, expected)) return false;
    const immediate = await snapshotZero(path, [1, 2]);
    if (immediate === null) { await syncDirectory(); return false; }
    if (!sameFileInode(immediate, expected) || !sameFileExact(immediate, expected)) return false;
    await options.hookForTest?.("before_unlink_exact", path);
    try { await unlink(path); } catch (error) {
      if (!missing(error)) fail();
      await syncDirectory();
      return false;
    }
    await syncDirectory();
    return true;
  };
  const readFinal = async (path: string, expected: Uint8Array): Promise<"absent" | "exact" | "prefix"> => {
    await checkChain();
    let before: FileIdentity;
    try { before = fileIdentity(await lstat(path, { bigint: true }), uid, [1]); }
    catch (error) { if (missing(error)) return "absent"; return fail(); }
    await options.hookForTest?.("after_final_lstat", path);
    if (before.size > expected.length) fail();
    let fd; let bytes: Uint8Array | undefined;
    try {
      fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fileIdentity(await fd.stat({ bigint: true }), uid, [1]);
      if (!sameFileNode(before, opened) || opened.size > expected.length) fail();
      bytes = new Uint8Array(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) fail();
        offset += read.bytesRead;
      }
      const after = fileIdentity(await fd.stat({ bigint: true }), uid, [1]);
      const named = fileIdentity(await lstat(path, { bigint: true }), uid, [1]);
      if (!sameFileNode(opened, after) || !sameFileNode(opened, named)) fail();
      if (!sameFileExact(opened, after) || !sameFileExact(opened, named)) return "prefix";
      for (let index = 0; index < bytes.length; index += 1) if (bytes[index] !== expected[index]) fail();
      return bytes.length === expected.length ? "exact" : "prefix";
    } catch (error) {
      if (missing(error)) return "absent";
      return fail();
    } finally { bytes?.fill(0); await fd?.close().catch(() => undefined); }
  };
  const createToken = async (token: string): Promise<FileIdentity | null> => {
    await checkChain();
    let fd;
    try {
      fd = await open(token, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      await fd.chmod(0o600);
      await options.hookForTest?.("after_token_open", token);
      // An identical publisher may link or finish tearing down this token as soon
      // as O_EXCL makes the pathname visible, before its creator reaches fstat.
      const openedInfo = await fd.stat({ bigint: true });
      if (openedInfo.nlink === 0n) { fileIdentity(openedInfo, uid, [0], true); return null; }
      const opened = fileIdentity(openedInfo, uid, [1, 2], true);
      await fd.sync();
      await options.hookForTest?.("after_token_sync", token);
      const afterInfo = await fd.stat({ bigint: true });
      if (afterInfo.nlink === 0n) { fileIdentity(afterInfo, uid, [0], true); return null; }
      const after = fileIdentity(afterInfo, uid, [1, 2], true);
      if (!sameFileInode(opened, after)) fail();
      await syncDirectory();
      await options.hookForTest?.("after_token_create", token);
      return after;
    } catch (error) { if (exists(error)) return null; return fail(); }
    finally { await fd?.close().catch(() => undefined); }
  };
  const writeSome = async (fd: FileHandle, bytes: Uint8Array, offset: number, limit: number): Promise<number> => {
    const testLimit = options.maxWriteBytesForTest;
    const requested = testLimit === undefined ? limit : Math.min(limit, testLimit);
    if (!Number.isSafeInteger(requested) || requested < 1) fail();
    const result = await fd.write(bytes, offset, requested, offset);
    if (result.bytesWritten < 1 || result.bytesWritten > requested) fail();
    return result.bytesWritten;
  };
  const publishImmutable = async (input: TargetSecretSourceFsPublishImmutableInput): Promise<void> => {
    let owned: Uint8Array | undefined;
    try {
      if (!input || typeof input !== "object" || !(input.bytes instanceof Uint8Array) || typeof input.final_path !== "string"
        || typeof input.publication_handle !== "string" || typeof input.proveExact !== "function") fail();
      owned = Uint8Array.from(input.bytes);
      if (owned.length < 1 || owned.length > MAX_BYTES) fail();
      const final = resolve(input.final_path);
      if (input.final_path !== final || dirname(final) !== resolve(paths.at(-1)!)) fail();
      const publicationHandle = parseTargetSecretSourceOpaqueHandle(input.publication_handle);
      const proveOwned = async (): Promise<void> => {
        const proofBytes = Uint8Array.from(owned!);
        try { await input.proveExact(proofBytes); } finally { proofBytes.fill(0); }
      };
      await proveOwned();
      const claim = `${final}.claim`;
      const token = `${final}.token.${publicationHandle}`;
      const retryContention = async (attempt: number, contestedPath: string, reason: string): Promise<void> => {
        options.contentionForTest?.(reason, attempt);
        await options.hookForTest?.("before_contention_retry", contestedPath);
        if (attempt >= MAX_ATTEMPTS - 1) fail();
        await contentionDelay(attempt);
      };
      const proveFinal = async (): Promise<boolean> => {
        if (await readFinal(final, owned!) !== "exact") return false;
        await proveOwned();
        return true;
      };
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const finalState = await readFinal(final, owned);
        const claimState = await snapshotZero(claim, [1, 2]);
        await options.hookForTest?.("after_claim_snapshot", claim);
        const tokenState = await snapshotZero(token, [1, 2]);
        if (finalState === "exact" && claimState === null && tokenState === null) {
          if (!await proveFinal()) fail();
          return;
        }
        if (claimState !== null && tokenState === null) {
          if (finalState !== "exact" || claimState.nlink !== 1n) { await retryContention(attempt, claim, "orphan-claim-not-cleanable"); continue; }
          if (!await proveFinal()) fail();
          if (!await unlinkExact(claim, claimState)) {
            const latestClaim = await snapshotZero(claim, [1, 2]);
            if (latestClaim === null) { if (!await proveFinal()) fail(); return; }
            if (!sameFileInode(latestClaim, claimState)) fail();
            await retryContention(attempt, claim, "orphan-claim-cleanup-race"); continue;
          }
          return;
        }
        let ownedToken = tokenState;
        if (ownedToken === null) ownedToken = await createToken(token);
        if (ownedToken === null) { await retryContention(attempt, token, "token-election-race"); continue; }
        let currentClaim = await snapshotZero(claim, [1, 2]);
        if (currentClaim === null && ownedToken.nlink === 1n) {
          try { await checkChain(); await link(token, claim); } catch (error) { if (!exists(error)) fail(); }
          await syncDirectory();
          await options.hookForTest?.("after_claim_link", claim);
          currentClaim = await snapshotZero(claim, [1, 2]);
          ownedToken = await snapshotZero(token, [1, 2]);
        }
        if (!currentClaim || !ownedToken) { await retryContention(attempt, claim, "topology-observation-race"); continue; }
        if (currentClaim.dev !== ownedToken.dev || currentClaim.ino !== ownedToken.ino) {
          await options.hookForTest?.("after_mismatch_snapshot", token);
          if (ownedToken.nlink === 1n) {
            const latest = await snapshotZero(token, [1, 2]);
            if (latest?.nlink === 1n && sameFileExact(latest, ownedToken)) await unlinkExact(token, latest);
          }
          await retryContention(attempt, claim, "foreign-token-race");
          continue;
        }
        if (currentClaim.nlink !== 2n || ownedToken.nlink !== 2n) { await retryContention(attempt, claim, "link-count-race"); continue; }
        const state = await readFinal(final, owned);
        if (state === "absent") {
          let fd;
          try {
            fd = await open(final, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
            await fd.chmod(0o600);
            await options.hookForTest?.("after_final_open", final);
            const created = fileIdentity(await fd.stat({ bigint: true }), uid, [1]);
            if (created.size > owned.length) fail();
            await options.hookForTest?.("after_final_create", final);
            const split = Math.max(created.size, 1, Math.floor(owned.length / 2));
            let offset = created.size;
            while (offset < split) offset += await writeSome(fd, owned, offset, split - offset);
            await options.hookForTest?.("after_partial_write", final);
            while (offset < owned.length) offset += await writeSome(fd, owned, offset, owned.length - offset);
            await fd.sync();
            const complete = fileIdentity(await fd.stat({ bigint: true }), uid, [1]);
            if (!sameFileNode(created, complete) || complete.size !== owned.length) fail();
            await options.hookForTest?.("after_file_sync", final);
          } catch (error) { if (!exists(error)) fail(); } finally { await fd?.close().catch(() => undefined); }
        } else if (state === "prefix") {
          let fd;
          try {
            fd = await open(final, constants.O_RDWR | constants.O_NOFOLLOW);
            const before = fileIdentity(await fd.stat({ bigint: true }), uid, [1]);
            if (before.size > owned.length) fail();
            let offset = before.size;
            while (offset < owned.length) offset += await writeSome(fd, owned, offset, owned.length - offset);
            await fd.sync();
            const after = fileIdentity(await fd.stat({ bigint: true }), uid, [1]);
            if (!sameFileNode(before, after) || after.size !== owned.length) fail();
          } catch { fail(); } finally { await fd?.close().catch(() => undefined); }
        }
        if (!await proveFinal()) { await retryContention(attempt, final, "final-write-race"); continue; }
        await syncDirectory();
        await options.hookForTest?.("after_directory_sync", final);
        const exactToken = await snapshotZero(token, [1, 2]);
        await options.hookForTest?.("after_exact_token_snapshot", token);
        const exactClaim = await snapshotZero(claim, [1, 2]);
        if (!exactToken || !exactClaim || exactToken.dev !== exactClaim.dev || exactToken.ino !== exactClaim.ino
          || exactToken.nlink !== 2n || exactClaim.nlink !== 2n) { await retryContention(attempt, claim, "cleanup-snapshot-race"); continue; }
        await unlinkExact(token, exactToken);
        await options.hookForTest?.("after_token_cleanup", token);
        const remainingClaim = await snapshotZero(claim, [1, 2]);
        if (remainingClaim === null) { if (!await proveFinal()) fail(); return; }
        if (remainingClaim.nlink !== 1n) {
          await retryContention(attempt, claim, "claim-final-cleanup-race"); continue;
        }
        if (!await unlinkExact(claim, remainingClaim)) {
          const latestClaim = await snapshotZero(claim, [1, 2]);
          if (latestClaim === null) { if (!await proveFinal()) fail(); return; }
          if (!sameFileInode(latestClaim, remainingClaim)) fail();
          await retryContention(attempt, claim, "claim-final-cleanup-race"); continue;
        }
        await options.hookForTest?.("after_claim_cleanup", claim);
        if (!await proveFinal()) fail();
        return;
      }
      fail();
    } catch { fail(); } finally { owned?.fill(0); }
  };
  return Object.freeze({ publishImmutable });
};
