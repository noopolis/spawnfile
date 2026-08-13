import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { createMemoryTargetLocalBundleStore, type TargetLocalBundleMemoryStore, type TargetLocalBundleStore } from "./containerBundleStore.js";

const ERROR = "Target-local container bundle store failed";
const OWNER = process.getuid?.() ?? -1;
const MAX_RECORD_BYTES = 4_194_304;
const STALE_LOCK_MS = 60_000;
const fail = (): never => { throw new Error(ERROR); };
const replayInput = (raw: unknown): { readonly idempotency_key: string; readonly maximum_wait_ms: number; readonly request_digest: string } => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== "idempotency_key\0maximum_wait_ms\0request_digest"
    || typeof value.idempotency_key !== "string" || !/^idem_[a-z0-9]{16,64}$/u.test(value.idempotency_key)
    || typeof value.request_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.request_digest)
    || !Number.isSafeInteger(value.maximum_wait_ms) || (value.maximum_wait_ms as number) < 0 || (value.maximum_wait_ms as number) > 30_000) return fail();
  return Object.freeze({ idempotency_key: value.idempotency_key, maximum_wait_ms: value.maximum_wait_ms as number, request_digest: value.request_digest });
};

interface DirectoryIdentity { readonly dev: number; readonly ino: number; readonly path: string; }
interface SecureDirectory { readonly identities: readonly DirectoryIdentity[]; readonly path: string; }

const secureDirectory = async (raw: unknown): Promise<SecureDirectory> => {
  if (typeof raw !== "string" || !path.isAbsolute(raw) || path.parse(raw).root === raw || raw.length > 4096 || path.normalize(raw) !== raw) fail();
  /* Resolve pre-existing platform aliases once, then retain physical ancestor
     identities. Subsequent alias/root swaps cannot redirect a state operation. */
  const requested = raw as string; const root = path.join(await realpath(path.dirname(requested)).catch(fail), path.basename(requested)); const parsed = path.parse(root); let current = parsed.root;
  const identities: DirectoryIdentity[] = [];
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let info;
    try { info = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(); await mkdir(current, { mode: 0o700 }); info = await lstat(current).catch(fail);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    identities.push(Object.freeze({ dev: info.dev, ino: info.ino, path: current }));
  }
  await chmod(root, 0o700).catch(fail); const final = await lstat(root).catch(fail);
  const rootIdentity = identities.at(-1);
  if (!rootIdentity || final.dev !== rootIdentity.dev || final.ino !== rootIdentity.ino
    || final.uid !== OWNER || (final.mode & 0o777) !== 0o700) fail();
  return Object.freeze({ identities: Object.freeze(identities), path: root });
};
const assertSecureDirectory = async (directory: SecureDirectory): Promise<void> => {
  for (const expected of directory.identities) {
    const current = await lstat(expected.path).catch(fail);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) fail();
  }
  const root = await lstat(directory.path).catch(fail);
  if (root.uid !== OWNER || (root.mode & 0o777) !== 0o700) fail();
};
const read = async (directory: SecureDirectory, file: string, maximum = MAX_RECORD_BYTES): Promise<Buffer | null> => {
  await assertSecureDirectory(directory);
  let handle; try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await assertSecureDirectory(directory); return null; } fail(); }
  try { const opened = handle!; const stat = await opened.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== OWNER || (stat.mode & 0o777) !== 0o600 || stat.size > maximum) fail(); const bytes = await opened.readFile(); await assertSecureDirectory(directory); return bytes; }
  finally { await handle?.close().catch(() => undefined); }
};
const syncDirectory = async (directory: string): Promise<void> => { const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } };
const write = async (directory: SecureDirectory, file: string, content: string | Uint8Array): Promise<void> => {
  await assertSecureDirectory(directory); const temp = `${file}.${process.pid}.${randomUUID()}.tmp`; let handle;
  try { handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await handle.writeFile(content); await handle.sync(); await handle.close(); handle = undefined; await assertSecureDirectory(directory); await rename(temp, file); await syncDirectory(path.dirname(file)); await assertSecureDirectory(directory); }
  catch { await handle?.close().catch(() => undefined); fail(); }
};
const acquire = async (directory: SecureDirectory, lock: string): Promise<() => Promise<void>> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await assertSecureDirectory(directory);
    try { const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await handle.close(); await assertSecureDirectory(directory); return async () => { await assertSecureDirectory(directory); await unlink(lock).catch(fail); await assertSecureDirectory(directory); }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail();
      const current = await lstat(lock).catch(() => null);
      if (!current) continue;
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== OWNER || (current.mode & 0o777) !== 0o600) fail();
      if (Date.now() - current.mtimeMs > STALE_LOCK_MS) { await unlink(lock).catch(() => undefined); continue; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return fail();
};

/** Secure single-file persistence around the strict exact-key store. */
export const initializeFilesystemTargetLocalBundleStore = async (root: unknown): Promise<TargetLocalBundleStore> => {
  const directory = await secureDirectory(root); const archives = await secureDirectory(path.join(directory.path, "archives")); const file = path.join(directory.path, "container-bundles.json"); const lock = `${file}.lock`;
  const archive = async (digest: unknown): Promise<Buffer> => {
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) fail();
    const exactDigest = digest as string; const bytes = await read(archives, path.join(archives.path, exactDigest.slice(7)), 4_194_304);
    if (!bytes || bytes.byteLength > 4_194_304 || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== exactDigest) fail();
    return bytes as Buffer;
  };
  const writeArchive = async (request: { readonly archive_base64: string; readonly archive_digest: string }): Promise<void> => {
    const bytes = Buffer.from(request.archive_base64, "base64");
    if (bytes.byteLength > 4_194_304 || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== request.archive_digest) fail();
    const target = path.join(archives.path, request.archive_digest.slice(7)); const current = await read(archives, target, 4_194_304);
    if (current && !current.equals(bytes)) fail(); else if (!current) await write(archives, target, bytes);
  };
  const load = async (): Promise<TargetLocalBundleMemoryStore> => {
    await assertSecureDirectory(directory); await assertSecureDirectory(archives);
    const store = createMemoryTargetLocalBundleStore(); const text = await read(directory, file); if (!text) return store;
    let state: unknown; try { state = JSON.parse(text.toString("utf8")); } catch { fail(); }
    if (!state || typeof state !== "object" || Array.isArray(state)) fail();
    const value = state as Record<string, unknown>; const records = value.records;
    if (!Array.isArray(records) || Object.keys(value).sort().join("\0") !== "records\0version"
      || value.version !== "spawnfile.target-local-container-bundle.private.v2") fail();
    const hydrated = await Promise.all((records as unknown[]).map(async (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(); const record = raw as Record<string, unknown>;
      if (!record.request || typeof record.request !== "object" || Array.isArray(record.request)) fail(); const request = record.request as Record<string, unknown>;
      if (Object.keys(request).includes("archive_base64") || typeof request.archive_digest !== "string") fail();
      return { ...record, request: { ...request, archive_base64: (await archive(request.archive_digest)).toString("base64") } };
    }));
    store.restore(hydrated);
    return store;
  };
  const save = async (store: TargetLocalBundleMemoryStore): Promise<void> => {
    const records = store.snapshot(); await Promise.all(records.map((record) => writeArchive(record.request)));
    const privateRecords = records.map(({ request, ...record }) => { const { archive_base64: _archive, ...metadata } = request; return { ...record, request: metadata }; });
    await write(directory, file, JSON.stringify({ records: privateRecords, version: "spawnfile.target-local-container-bundle.private.v2" }));
  };
  const mutate = async <T>(action: (store: TargetLocalBundleMemoryStore) => Promise<T>): Promise<T> => { const release = await acquire(directory, lock); try { const store = await load(); const result = await action(store); await save(store); return result; } finally { await release(); } };
  /* The production adapter persists its exact mapping separately; this store keeps
     admissions strict and intentionally exposes no scan/list primitive. */
  const store: TargetLocalBundleStore = {
    awaitReplay: async (raw) => {
      const value = replayInput(raw); const deadline = Date.now() + value.maximum_wait_ms;
      for (;;) {
        const result = await load().then((memory) => memory.lookup(value));
        if (result.status !== "pending" || Date.now() >= deadline) return result;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    beginBuild: (value) => mutate((memory) => memory.beginBuild(value)),
    reserve: (raw: unknown) => mutate((memory) => memory.reserve(raw)),
    renew: (value) => mutate((memory) => memory.renew(value)),
    retryMissingCompleted: (value) => mutate((memory) => memory.retryMissingCompleted(value)),
    retryPrebuild: (value) => mutate((memory) => memory.retryPrebuild(value)),
    complete: (value) => mutate((memory) => memory.complete(value)),
    markIncomplete: (value) => mutate((memory) => memory.markIncomplete(value)),
    resolve: (value) => load().then((memory) => memory.resolve(value)),
    resolvePrepared: (value) => load().then((memory) => memory.resolvePrepared(value)),
    stagePostbuild: (value) => mutate((memory) => memory.stagePostbuild(value)),
    lookup: (value) => load().then((memory) => memory.lookup(value))
  };
  return Object.freeze(store);
};
