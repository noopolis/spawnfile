import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseRunId,
  type OpaqueTargetHandle
} from "./contracts.js";
import { DOCKER_SECRET_ERROR } from "./dockerSecretsProvider.js";

export const TARGET_SECRET_SOURCE_AUTHORIZATION_VERSION = "spawnfile.target-secret-source.authorization.v1" as const;
const TARGET_SECRET_VERSION_STORE = "spawnfile.target-secret-source.private-version-store.v1" as const;
const TARGET_SECRET_SOURCE_BINDING = "spawnfile.target-secret-source.private-binding.v1" as const;
const MAX_RECORD_BYTES = 32_768;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{32}$/u;

export interface TargetSecretSourceAuthorization {
  readonly descriptorDigest: string;
  readonly name: string;
  readonly operationHandle: OpaqueTargetHandle;
  readonly requestDigest: string;
  readonly runId: string;
  readonly scope: string;
  readonly selectedTarget: {
    readonly fingerprint: string;
    readonly handle: OpaqueTargetHandle;
  };
  readonly sourceHandle: OpaqueTargetHandle;
  readonly version: typeof TARGET_SECRET_SOURCE_AUTHORIZATION_VERSION;
}

export interface TargetSecretVersionBinding {
  readonly authorization: TargetSecretSourceAuthorization;
  readonly sourceVersionHandle: OpaqueTargetHandle;
}

export interface TargetSecretVersionAuthorityStore {
  bind(bindings: readonly TargetSecretVersionBinding[]): Promise<void>;
}

const fail = (): never => { throw new Error(DOCKER_SECRET_ERROR); };
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const digest = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-secret-authority.${domain}.v1\0`, "utf8").update(value, "utf8").digest("hex");
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const parseTargetSecretSourceAuthorization = (raw: unknown): TargetSecretSourceAuthorization => {
  assertOrdinaryJsonGraph(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, [
    "descriptorDigest", "name", "operationHandle", "requestDigest", "runId", "scope",
    "selectedTarget", "sourceHandle", "version"
  ]) || value.version !== TARGET_SECRET_SOURCE_AUTHORIZATION_VERSION
    || typeof value.descriptorDigest !== "string" || !DIGEST_PATTERN.test(value.descriptorDigest)
    || typeof value.requestDigest !== "string" || !DIGEST_PATTERN.test(value.requestDigest)
    || typeof value.name !== "string" || !IDENTIFIER_PATTERN.test(value.name)
    || typeof value.scope !== "string" || !IDENTIFIER_PATTERN.test(value.scope)) return fail();
  const selected = value.selectedTarget;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)
    || !exactKeys(selected as Record<string, unknown>, ["fingerprint", "handle"])) return fail();
  const target = selected as Record<string, unknown>;
  if (typeof target.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(target.fingerprint)) return fail();
  return Object.freeze({
    descriptorDigest: value.descriptorDigest, name: value.name,
    operationHandle: parseOpaqueTargetHandle(value.operationHandle), requestDigest: value.requestDigest,
    runId: parseRunId(value.runId), scope: value.scope,
    selectedTarget: Object.freeze({ fingerprint: target.fingerprint, handle: parseOpaqueTargetHandle(target.handle) }),
    sourceHandle: parseOpaqueTargetHandle(value.sourceHandle), version: TARGET_SECRET_SOURCE_AUTHORIZATION_VERSION
  });
};

export const createTargetSecretSourceAuthorization = (
  raw: Omit<TargetSecretSourceAuthorization, "version">
): TargetSecretSourceAuthorization => {
  assertOrdinaryJsonGraph(raw);
  return parseTargetSecretSourceAuthorization({ ...raw, version: TARGET_SECRET_SOURCE_AUTHORIZATION_VERSION });
};

interface AuthorityRecord { readonly content: string; readonly key: string; }
const bindingBytes = (raw: readonly TargetSecretVersionBinding[]): {
  readonly claim: AuthorityRecord;
  readonly sources: readonly AuthorityRecord[];
} => {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) return fail();
  const bindings = raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail();
    const authorization = parseTargetSecretSourceAuthorization(entry.authorization);
    return Object.freeze({ authorization, sourceVersionHandle: parseOpaqueTargetHandle(entry.sourceVersionHandle) });
  }).sort((left, right) => left.authorization.scope.localeCompare(right.authorization.scope)
    || left.authorization.name.localeCompare(right.authorization.name));
  const first = bindings[0]!.authorization;
  const destinations = new Set<string>(); const sources = new Set<string>();
  for (const binding of bindings) {
    const authorization = binding.authorization;
    if (authorization.operationHandle !== first.operationHandle || authorization.requestDigest !== first.requestDigest
      || authorization.runId !== first.runId || authorization.descriptorDigest !== first.descriptorDigest
      || authorization.selectedTarget.fingerprint !== first.selectedTarget.fingerprint
      || authorization.selectedTarget.handle !== first.selectedTarget.handle) return fail();
    const destination = `${authorization.scope}\0${authorization.name}`;
    if (destinations.has(destination) || sources.has(authorization.sourceHandle)) return fail();
    destinations.add(destination); sources.add(authorization.sourceHandle);
  }
  const content = JSON.stringify({ bindings, version: TARGET_SECRET_VERSION_STORE });
  if (bytes(content) > MAX_RECORD_BYTES) return fail();
  const sourcesRecords = bindings.map((binding) => {
    const sourceContent = JSON.stringify({ ...binding, version: TARGET_SECRET_SOURCE_BINDING });
    if (bytes(sourceContent) > MAX_RECORD_BYTES) return fail();
    return { content: sourceContent, key: digest("source-file", binding.authorization.sourceHandle) };
  });
  return {
    claim: { content, key: digest("claim-file", `${first.operationHandle}\0${first.requestDigest}`) },
    sources: sourcesRecords
  };
};

const checkRoot = async (raw: unknown): Promise<string> => {
  if (typeof raw !== "string" || raw.length < 1 || bytes(raw) > 4_096) return fail();
  const root = path.resolve(raw); const parsed = path.parse(root); let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let stats;
    try { stats = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
      await mkdir(current, { mode: 0o700 }).catch((mkdirError: NodeJS.ErrnoException) => {
        if (mkdirError.code !== "EEXIST") return fail();
      });
      stats = await lstat(current).catch(fail);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return fail();
  }
  await chmod(root, 0o700).catch(fail); return root;
};

const readRecord = async (filePath: string): Promise<string | null> => {
  let stats;
  try { stats = await lstat(filePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_RECORD_BYTES || (stats.mode & 0o077) !== 0) return fail();
  let handle;
  try { handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail(); }
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_RECORD_BYTES || (current.mode & 0o077) !== 0) return fail();
    return await handle.readFile({ encoding: "utf8" });
  } catch { return fail(); } finally { await handle.close().catch(() => undefined); }
};
const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); }
};

class FileTargetSecretVersionAuthorityStore implements TargetSecretVersionAuthorityStore {
  readonly #root: string;
  public constructor(root: string) { this.#root = root; }
  private async bindRecord(record: AuthorityRecord): Promise<void> {
    const finalPath = path.join(this.#root, `${record.key}.json`);
    const existing = await readRecord(finalPath); if (existing !== null) { if (existing !== record.content) return fail(); return; }
    const temporaryPath = path.join(this.#root, `.${record.key}.${process.pid}.${randomUUID()}.tmp`); let handle;
    try {
      handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600); await handle.writeFile(record.content, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
      try { await link(temporaryPath, finalPath); await syncDirectory(this.#root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      await syncDirectory(this.#root);
    }
    if (await readRecord(finalPath) !== record.content) return fail();
  }
  public async bind(bindings: readonly TargetSecretVersionBinding[]): Promise<void> {
    try {
      const records = bindingBytes(bindings);
      for (const source of records.sources) await this.bindRecord(source);
      await this.bindRecord(records.claim);
    } catch { return fail(); }
  }
}

export const initializeTargetSecretVersionAuthorityStore = async (
  root: unknown
): Promise<TargetSecretVersionAuthorityStore> => new FileTargetSecretVersionAuthorityStore(await checkRoot(root));
