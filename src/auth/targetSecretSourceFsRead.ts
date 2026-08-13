import { Buffer } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";

import { MAX_JSON_GRAPH_STRING_BYTES, TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle } from "./targetSecretSourceRecordCommon.js";
import { parseTargetSecretSourceAliasRecordBytes, parseTargetSecretSourceVersionRecordBytes, type TargetSecretSourceAliasRecord, type TargetSecretSourceVersionRecord } from "./targetSecretSourceVersionRecords.js";
import { parseTargetSecretSourceGrantRecordBytes, parseTargetSecretSourceRedemptionRecordBytes, parseTargetSecretSourceRevocationRecordBytes, type TargetSecretSourceGrantRecord, type TargetSecretSourceRedemptionRecord, type TargetSecretSourceRevocationRecord } from "./targetSecretSourceGrantRecords.js";
import { resolveAuthHome, resolveSpawnfileHome, resolveTargetSecretAliasPath, resolveTargetSecretAliasesDirectory, resolveTargetSecretGrantPath, resolveTargetSecretGrantsDirectory, resolveTargetSecretRedemptionPath, resolveTargetSecretRedemptionsDirectory, resolveTargetSecretRevocationPath, resolveTargetSecretRevocationsDirectory, resolveTargetSecretVersionPath, resolveTargetSecretVersionsDirectory, resolveTargetSecretsRoot } from "./paths.js";

type Handle = ReturnType<typeof parseTargetSecretSourceOpaqueHandle>;
type DirectoryIdentity = {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
};
type FileIdentity = {
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: number;
  readonly uid: bigint;
};
type Parser<T> = (bytes: Uint8Array, expected: Handle) => T;
export interface TargetSecretSourceFsRead {
  readAlias(handle: unknown): Promise<TargetSecretSourceAliasRecord | null>;
  readGrant(handle: unknown): Promise<TargetSecretSourceGrantRecord | null>;
  readRedemption(handle: unknown): Promise<TargetSecretSourceRedemptionRecord | null>;
  readRevocation(handle: unknown): Promise<TargetSecretSourceRevocationRecord | null>;
  readVersion(handle: unknown): Promise<TargetSecretSourceVersionRecord | null>;
}
export interface TargetSecretSourceFsReadOptions {
  readonly beforeLeafLstatForTest?: (path: string) => Promise<void> | void;
  readonly beforeOpenForTest?: (path: string) => Promise<void> | void;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const uid = (): number => { const value = process.getuid?.(); if (typeof value !== "number") return fail(); return value; };
const directoryIdentity = (info: BigIntStats, owner: number): DirectoryIdentity => {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(owner) || (info.mode & 0o7777n) !== 0o700n) return fail();
  return { birthtimeNs: info.birthtimeNs, dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid };
};
const fileIdentity = (info: BigIntStats, owner: number): FileIdentity => {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== BigInt(owner) || info.nlink !== 1n || info.size < 0n || info.size > BigInt(MAX_JSON_GRAPH_STRING_BYTES) || (info.mode & 0o7777n) !== 0o600n) return fail();
  return { birthtimeNs: info.birthtimeNs, ctimeNs: info.ctimeNs, dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, size: Number(info.size), uid: info.uid };
};
const sameDirectory = (left: DirectoryIdentity, right: DirectoryIdentity): boolean => left.birthtimeNs === right.birthtimeNs && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid;
const sameFile = (left: FileIdentity, right: FileIdentity): boolean => left.birthtimeNs === right.birthtimeNs && left.ctimeNs === right.ctimeNs && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.uid === right.uid;

const initializeDirectory = async (directory: string, owner: number, create: boolean): Promise<DirectoryIdentity> => {
  let info;
  try { info = await lstat(directory, { bigint: true }); }
  catch (error) {
    if (!create || !absent(error)) return fail();
    try { await mkdir(directory, { mode: 0o700 }); info = await lstat(directory, { bigint: true }); } catch { return fail(); }
  }
  const before = directoryIdentity(info, owner); let handle;
  try { handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch { return fail(); }
  try {
    const opened = directoryIdentity(await handle.stat({ bigint: true }), owner); const after = directoryIdentity(await lstat(directory, { bigint: true }), owner);
    if (!sameDirectory(before, opened) || !sameDirectory(before, after)) return fail(); return opened;
  }
  catch { return fail(); }
  finally { await handle.close().catch(() => undefined); }
};

const checkChain = async (chain: readonly { readonly path: string; readonly identity: DirectoryIdentity }[], owner: number): Promise<void> => {
  for (const entry of chain) {
    let info; try { info = await lstat(entry.path, { bigint: true }); } catch { return fail(); }
    const before = directoryIdentity(info, owner); if (!sameDirectory(before, entry.identity)) return fail();
    let handle; try { handle = await open(entry.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); } catch { return fail(); }
    try {
      const opened = directoryIdentity(await handle.stat({ bigint: true }), owner); const after = directoryIdentity(await lstat(entry.path, { bigint: true }), owner);
      if (!sameDirectory(opened, entry.identity) || !sameDirectory(after, entry.identity)) return fail();
    }
    catch { return fail(); }
    finally { await handle.close().catch(() => undefined); }
  }
};

const readRecord = async <T>(file: string, expected: Handle, parse: Parser<T>, chain: readonly { readonly path: string; readonly identity: DirectoryIdentity }[], owner: number, hooks: TargetSecretSourceFsReadOptions): Promise<T | null> => {
  await checkChain(chain, owner);
  try { await hooks.beforeLeafLstatForTest?.(file); } catch { return fail(); }
  let beforeInfo;
  try { beforeInfo = await lstat(file, { bigint: true }); }
  catch (error) {
    if (!absent(error)) return fail();
    await checkChain(chain, owner);
    try { beforeInfo = await lstat(file, { bigint: true }); } catch (retry) { if (absent(retry)) return null; return fail(); }
  }
  const before = fileIdentity(beforeInfo, owner);
  try { await hooks.beforeOpenForTest?.(file); } catch { return fail(); }
  let handle; try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail(); }
  let bytes: Buffer | undefined;
  try {
    const opened = fileIdentity(await handle.stat({ bigint: true }), owner); if (!sameFile(before, opened)) return fail();
    bytes = Buffer.alloc(opened.size + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (result.bytesRead === 0) break; offset += result.bytesRead; }
    const after = fileIdentity(await handle.stat({ bigint: true }), owner); let pathname;
    try { pathname = fileIdentity(await lstat(file, { bigint: true }), owner); } catch { return fail(); }
    if (offset !== opened.size || !sameFile(opened, after) || !sameFile(opened, pathname)) return fail();
    await checkChain(chain, owner);
    const content = Uint8Array.from(bytes.subarray(0, offset)); try { return parse(content, expected); } finally { content.fill(0); }
  } catch { return fail(); }
  finally { bytes?.fill(0); await handle.close().catch(() => undefined); }
};

export const initializeTargetSecretSourceFsRead = async (options: TargetSecretSourceFsReadOptions = {}): Promise<TargetSecretSourceFsRead> => {
  const owner = uid();
  const paths = [resolveSpawnfileHome(), resolveAuthHome(), resolveTargetSecretsRoot(), resolveTargetSecretVersionsDirectory(), resolveTargetSecretGrantsDirectory(), resolveTargetSecretRedemptionsDirectory(), resolveTargetSecretRevocationsDirectory(), resolveTargetSecretAliasesDirectory()];
  const identities: DirectoryIdentity[] = [];
  for (let index = 0; index < paths.length; index += 1) identities.push(await initializeDirectory(paths[index]!, owner, index > 0));
  const chains = Object.freeze({ aliases: paths.slice(0, 8).map((path, index) => ({ path, identity: identities[index]! })), grants: paths.slice(0, 5).map((path, index) => ({ path, identity: identities[index]! })), redemptions: paths.slice(0, 6).map((path, index) => ({ path, identity: identities[index]! })), revocations: paths.slice(0, 7).map((path, index) => ({ path, identity: identities[index]! })), versions: paths.slice(0, 4).map((path, index) => ({ path, identity: identities[index]! })) });
  const read = <T>(raw: unknown, pathFor: (handle: string) => string, parse: Parser<T>, chain: readonly { readonly path: string; readonly identity: DirectoryIdentity }[]): Promise<T | null> => {
    let handle: Handle; try { handle = parseTargetSecretSourceOpaqueHandle(raw); } catch { return Promise.reject(new Error(TARGET_SECRET_SOURCE_ERROR)); }
    return readRecord(pathFor(handle), handle, parse, chain, owner, options);
  };
  return Object.freeze({
    readAlias: (handle: unknown) => read(handle, resolveTargetSecretAliasPath, parseTargetSecretSourceAliasRecordBytes, chains.aliases),
    readGrant: (handle: unknown) => read(handle, resolveTargetSecretGrantPath, parseTargetSecretSourceGrantRecordBytes, chains.grants),
    readRedemption: (handle: unknown) => read(handle, resolveTargetSecretRedemptionPath, parseTargetSecretSourceRedemptionRecordBytes, chains.redemptions),
    readRevocation: (handle: unknown) => read(handle, resolveTargetSecretRevocationPath, parseTargetSecretSourceRevocationRecordBytes, chains.revocations),
    readVersion: (handle: unknown) => read(handle, resolveTargetSecretVersionPath, parseTargetSecretSourceVersionRecordBytes, chains.versions)
  });
};
