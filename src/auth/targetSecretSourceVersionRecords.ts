import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import {
  TARGET_SECRET_SOURCE_ERROR,
  assertOrdinaryJsonGraph,
  createCanonicalTargetSecretSourceJson,
  decodeTargetSecretSourceSecret,
  encodeTargetSecretSourceSecret,
  parseCanonicalTargetSecretSourceJson,
  parseTargetSecretSourceOpaqueHandle
} from "./targetSecretSourceRecordCommon.js";

export const TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION = "spawnfile.auth.target-secret.source-version.v1" as const;
export const TARGET_SECRET_SOURCE_ALIAS_RECORD_VERSION = "spawnfile.auth.target-secret.source-alias.v1" as const;
const VERSION_KEYS = ["publication_handle", "secret", "source_version_handle", "version"] as const;
const ALIAS_KEYS = ["publication_handle", "source_handle", "source_version_handle", "version"] as const;
const ALIAS_METADATA_KEYS = ["source_handle", "source_version_handle", "version"] as const;
const VERSION_METADATA_KEYS = ["source_version_handle", "version"] as const;
const PRIVATE_VERSION_METADATA_KEYS = ["publication_handle", "source_version_handle", "version"] as const;

export type TargetSecretSourceOpaqueHandle = ReturnType<typeof parseTargetSecretSourceOpaqueHandle>;
export type TargetSecretSourceEntropy = () => Uint8Array;
export type TargetSecretSourceVersionMetadata = Readonly<{
  source_version_handle: TargetSecretSourceOpaqueHandle;
  version: typeof TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION;
}>;
export type TargetSecretSourcePrivateVersionMetadata = Readonly<TargetSecretSourceVersionMetadata & {
  publication_handle: TargetSecretSourceOpaqueHandle;
}>;
export type TargetSecretSourceVersionRecord = Readonly<TargetSecretSourcePrivateVersionMetadata & { secret: Uint8Array }>;
export type TargetSecretSourceAliasMetadata = Readonly<{
  source_handle: TargetSecretSourceOpaqueHandle;
  source_version_handle: TargetSecretSourceOpaqueHandle;
  version: typeof TARGET_SECRET_SOURCE_ALIAS_RECORD_VERSION;
}>;
export type TargetSecretSourceAliasRecord = Readonly<TargetSecretSourceAliasMetadata & {
  publication_handle: TargetSecretSourceOpaqueHandle;
}>;
export type TargetSecretSourceVersionRecordBytes = Uint8Array & { readonly __brand: "TargetSecretSourceVersionRecordBytes" };
export type TargetSecretSourceAliasRecordBytes = Uint8Array & { readonly __brand: "TargetSecretSourceAliasRecordBytes" };

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const normalize = <T>(work: () => T): T => {
  try {
    return work();
  } catch {
    return fail();
  }
};
const defaultEntropy: TargetSecretSourceEntropy = (): Uint8Array => {
  const bytes = randomBytes(16);
  try {
    return Uint8Array.from(bytes);
  } finally {
    bytes.fill(0);
  }
};
const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

const opaqueHandleFromEntropy = (entropy: TargetSecretSourceEntropy): TargetSecretSourceOpaqueHandle => normalize(() => {
  const raw = entropy();
  if (!(raw instanceof Uint8Array) || raw.length < 8 || raw.length > 32) fail();
  const copy = Uint8Array.from(raw);
  const encoded = Buffer.from(copy);
  try {
    return parseTargetSecretSourceOpaqueHandle(`opaque_${encoded.toString("hex")}`);
  } finally {
    encoded.fill(0);
    copy.fill(0);
  }
});

const exactRecord = (value: unknown, expected: readonly string[]): Record<string, unknown> => {
  assertOrdinaryJsonGraph(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail();
  return record;
};

const parseVersionMetadata = (value: unknown): TargetSecretSourceVersionMetadata => normalize(() => {
  const record = exactRecord(value, VERSION_METADATA_KEYS);
  if (record.version !== TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION) fail();
  return freeze({ source_version_handle: parseTargetSecretSourceOpaqueHandle(record.source_version_handle), version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION });
});

const parsePrivateVersionMetadata = (value: unknown): TargetSecretSourcePrivateVersionMetadata => normalize(() => {
  const record = exactRecord(value, PRIVATE_VERSION_METADATA_KEYS);
  if (record.version !== TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION) fail();
  const sourceVersionHandle = parseTargetSecretSourceOpaqueHandle(record.source_version_handle);
  const publicationHandle = parseTargetSecretSourceOpaqueHandle(record.publication_handle);
  if (sourceVersionHandle === publicationHandle) fail();
  return freeze({
    publication_handle: publicationHandle,
    source_version_handle: sourceVersionHandle,
    version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION
  });
});

const parseVersionPayload = (value: unknown): { readonly metadata: TargetSecretSourcePrivateVersionMetadata; readonly secret: string } => {
  const record = exactRecord(value, VERSION_KEYS);
  if (record.version !== TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION || typeof record.secret !== "string") fail();
  return {
    metadata: parsePrivateVersionMetadata({
      publication_handle: record.publication_handle,
      source_version_handle: record.source_version_handle,
      version: record.version
    }),
    secret: record.secret as string
  };
};

const parseAliasMetadata = (value: unknown): TargetSecretSourceAliasMetadata => {
  const record = exactRecord(value, ALIAS_METADATA_KEYS);
  if (record.version !== TARGET_SECRET_SOURCE_ALIAS_RECORD_VERSION) fail();
  const sourceHandle = parseTargetSecretSourceOpaqueHandle(record.source_handle);
  const sourceVersionHandle = parseTargetSecretSourceOpaqueHandle(record.source_version_handle);
  if (sourceHandle === sourceVersionHandle) fail();
  return freeze({ source_handle: sourceHandle, source_version_handle: sourceVersionHandle, version: TARGET_SECRET_SOURCE_ALIAS_RECORD_VERSION });
};

const parseAlias = (value: unknown): TargetSecretSourceAliasRecord => {
  const record = exactRecord(value, ALIAS_KEYS);
  const metadata = parseAliasMetadata({
    source_handle: record.source_handle,
    source_version_handle: record.source_version_handle,
    version: record.version
  });
  const publicationHandle = parseTargetSecretSourceOpaqueHandle(record.publication_handle);
  if (publicationHandle === metadata.source_handle || publicationHandle === metadata.source_version_handle) fail();
  return freeze({ publication_handle: publicationHandle, ...metadata });
};

export const createTargetSecretSourceVersionRecordBytes = (
  secret: Uint8Array,
  options: { readonly entropy?: TargetSecretSourceEntropy; readonly publicationEntropy?: TargetSecretSourceEntropy } = {}
): {
  readonly private_bytes: TargetSecretSourceVersionRecordBytes;
  readonly private_metadata: TargetSecretSourcePrivateVersionMetadata;
  readonly metadata: TargetSecretSourceVersionMetadata;
} => normalize(() => {
  const sourceVersionHandle = opaqueHandleFromEntropy(options.entropy ?? defaultEntropy);
  const publicationHandle = opaqueHandleFromEntropy(options.publicationEntropy ?? defaultEntropy);
  if (sourceVersionHandle === publicationHandle) fail();
  const metadata = freeze({
    source_version_handle: sourceVersionHandle,
    version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION
  });
  const privateMetadata = freeze({
    publication_handle: publicationHandle,
    ...metadata
  });
  const privateBytes = createCanonicalTargetSecretSourceJson({
    publication_handle: publicationHandle,
    secret: encodeTargetSecretSourceSecret(secret),
    source_version_handle: sourceVersionHandle,
    version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION
  }) as TargetSecretSourceVersionRecordBytes;
  return { private_bytes: privateBytes, private_metadata: privateMetadata, metadata };
});

export const parseTargetSecretSourceVersionRecordBytes = (
  raw: Uint8Array,
  expectedLeafHandle: TargetSecretSourceOpaqueHandle
): TargetSecretSourceVersionRecord => normalize(() => {
  const expected = parseTargetSecretSourceOpaqueHandle(expectedLeafHandle);
  const payload = parseVersionPayload(parseCanonicalTargetSecretSourceJson(raw));
  if (payload.metadata.source_version_handle !== expected) fail();
  return freeze({ ...payload.metadata, secret: decodeTargetSecretSourceSecret(payload.secret) });
});

export const createTargetSecretSourceAliasRecordBytes = (
  version: TargetSecretSourceVersionMetadata,
  options: { readonly entropy?: TargetSecretSourceEntropy; readonly publicationEntropy?: TargetSecretSourceEntropy } = {}
): {
  readonly private_bytes: TargetSecretSourceAliasRecordBytes;
  readonly private_metadata: TargetSecretSourceAliasRecord;
  readonly metadata: TargetSecretSourceAliasMetadata;
} => normalize(() => {
  const versionMetadata = parseVersionMetadata(version);
  const sourceHandle = opaqueHandleFromEntropy(options.entropy ?? defaultEntropy);
  const publicationHandle = opaqueHandleFromEntropy(options.publicationEntropy ?? defaultEntropy);
  if (
    sourceHandle === versionMetadata.source_version_handle
    || publicationHandle === sourceHandle
    || publicationHandle === versionMetadata.source_version_handle
  ) fail();
  const metadata = freeze({ source_handle: sourceHandle, source_version_handle: versionMetadata.source_version_handle, version: TARGET_SECRET_SOURCE_ALIAS_RECORD_VERSION });
  const privateMetadata = freeze({ publication_handle: publicationHandle, ...metadata });
  return {
    private_bytes: createCanonicalTargetSecretSourceJson(privateMetadata) as TargetSecretSourceAliasRecordBytes,
    private_metadata: privateMetadata,
    metadata
  };
});

export const parseTargetSecretSourceAliasRecordBytes = (
  raw: Uint8Array,
  expectedLeafHandle: TargetSecretSourceOpaqueHandle
): TargetSecretSourceAliasRecord => normalize(() => {
  const expected = parseTargetSecretSourceOpaqueHandle(expectedLeafHandle);
  const alias = parseTargetSecretSourceAliasRecordBytesForPublication(raw);
  if (alias.source_handle !== expected) fail();
  return alias;
});
export const parseTargetSecretSourceAliasRecordBytesForPublication = (
  raw: Uint8Array
): TargetSecretSourceAliasRecord => normalize(() => parseAlias(parseCanonicalTargetSecretSourceJson(raw)));

export const assertTargetSecretSourceAliasCorrelation = (
  alias: TargetSecretSourceAliasMetadata,
  version: TargetSecretSourceVersionMetadata
): void => normalize(() => {
  const parsedAlias = parseAliasMetadata(alias);
  const parsedVersion = parseVersionMetadata(version);
  if (parsedAlias.source_version_handle !== parsedVersion.source_version_handle) fail();
});
