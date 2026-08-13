import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";

import {
  MAX_TARGET_SECRET_SOURCE_SECRET_BYTES,
  TARGET_SECRET_SOURCE_ERROR,
  assertOrdinaryJsonGraph,
  createCanonicalTargetSecretSourceJson,
  parseCanonicalTargetSecretSourceJson,
  parseTargetSecretSourceOpaqueHandle,
  type OpaqueTargetSecretSourceHandle
} from "../auth/targetSecretSourceRecordCommon.js";
import {
  parseTargetSecretSourceGrantCommandInput,
  type TargetSecretSourceGrantCommandInput
} from "../auth/targetSecretSourceGrantRecords.js";

export const TARGET_SECRET_SOURCE_REQUEST_VERSION = "spawnfile.auth.target-secret.source-request.v1" as const;
export const TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION = "spawnfile.auth.target-secret.grant-request.v1" as const;
export const TARGET_SECRET_SOURCE_RECEIPT_VERSION = "spawnfile.auth.target-secret.receipt.v1" as const;
export const MAX_TARGET_SECRET_SOURCE_REQUEST_FILE_BYTES = 65_536;
export type TargetSecretSourceCommandKind = "author" | "grant" | "revoke-grant" | "revoke-version" | "rotate";
export type TargetSecretSourceRequest = Readonly<{
  source_handle: OpaqueTargetSecretSourceHandle;
  version: typeof TARGET_SECRET_SOURCE_REQUEST_VERSION;
}>;
export type TargetSecretSourceReceipt = Readonly<{
  kind: TargetSecretSourceCommandKind;
  source_handle: OpaqueTargetSecretSourceHandle;
  version: typeof TARGET_SECRET_SOURCE_RECEIPT_VERSION;
}>;

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const exact = (raw: unknown, keys: readonly string[]): Record<string, unknown> => {
  assertOrdinaryJsonGraph(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const record = raw as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail();
  return record;
};

export const parseTargetSecretSourceRequestBytes = (bytes: Uint8Array): TargetSecretSourceRequest => {
  const record = exact(parseCanonicalTargetSecretSourceJson(bytes), ["source_handle", "version"]);
  if (record.version !== TARGET_SECRET_SOURCE_REQUEST_VERSION) fail();
  return Object.freeze({
    source_handle: parseTargetSecretSourceOpaqueHandle(record.source_handle),
    version: TARGET_SECRET_SOURCE_REQUEST_VERSION
  });
};
export const parseTargetSecretSourceGrantRequestBytes = (
  bytes: Uint8Array
): TargetSecretSourceGrantCommandInput => {
  const record = exact(parseCanonicalTargetSecretSourceJson(bytes), ["grant", "version"]);
  if (record.version !== TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION) fail();
  return parseTargetSecretSourceGrantCommandInput(record.grant);
};

export interface TargetSecretSourceRequestFileOptions {
  readonly beforeReadForTest?: () => Promise<void> | void;
}

const readRequestFile = async <T>(
  filePath: string,
  parse: (bytes: Uint8Array) => T,
  options: TargetSecretSourceRequestFileOptions
): Promise<T> => {
  let bytes: Buffer | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_TARGET_SECRET_SOURCE_REQUEST_FILE_BYTES) fail();
    await options.beforeReadForTest?.();
    bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) fail();
    return parse(bytes.subarray(0, offset));
  } catch {
    return fail();
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
};
export const readTargetSecretSourceRequestFile = (
  filePath: string,
  options: TargetSecretSourceRequestFileOptions = {}
): Promise<TargetSecretSourceRequest> => readRequestFile(filePath, parseTargetSecretSourceRequestBytes, options);
export const readTargetSecretSourceGrantRequestFile = (
  filePath: string,
  options: TargetSecretSourceRequestFileOptions = {}
): Promise<TargetSecretSourceGrantCommandInput> => readRequestFile(
  filePath, parseTargetSecretSourceGrantRequestBytes, options
);

export const createTargetSecretSourceReceiptBytes = (
  raw: Readonly<{ kind: TargetSecretSourceCommandKind; source_handle: unknown }>
): Uint8Array => {
  try {
    const record = exact(raw, ["kind", "source_handle"]);
    const kinds: readonly TargetSecretSourceCommandKind[] = ["author", "grant", "revoke-grant", "revoke-version", "rotate"];
    if (!kinds.includes(record.kind as TargetSecretSourceCommandKind)) fail();
    const receipt: TargetSecretSourceReceipt = Object.freeze({
      kind: record.kind as TargetSecretSourceCommandKind,
      source_handle: parseTargetSecretSourceOpaqueHandle(record.source_handle),
      version: TARGET_SECRET_SOURCE_RECEIPT_VERSION
    });
    const canonical = createCanonicalTargetSecretSourceJson(receipt);
    return canonical;
  } catch {
    return fail();
  }
};

export const readBoundedTargetSecretStdin = async (
  input: AsyncIterable<unknown>,
  maximumBytes: number
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (!input || typeof input[Symbol.asyncIterator] !== "function"
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || maximumBytes > MAX_TARGET_SECRET_SOURCE_SECRET_BYTES) fail();
    for await (const raw of input) {
      if (typeof raw === "string" && Buffer.byteLength(raw, "utf8") > maximumBytes - total) fail();
      if (raw instanceof Uint8Array && raw.byteLength > maximumBytes - total) fail();
      const chunk = typeof raw === "string" ? new TextEncoder().encode(raw)
        : raw instanceof Uint8Array ? Uint8Array.from(raw) : fail();
      chunks.push(chunk);
      total += chunk.length;
      if (total > maximumBytes) fail();
    }
    if (total === 0) fail();
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } catch {
    return fail();
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
};
