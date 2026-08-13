import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import {
  parseTargetSecretSourceAuthorization,
  type TargetSecretSourceAuthorization
} from "../target/dockerSecretsAuthority.js";
import { parseRunId, parseSelectedTargetReceipt, type SelectedTargetReceipt } from "../target/contracts.js";
import {
  TARGET_SECRET_SOURCE_ERROR,
  assertOrdinaryJsonGraph,
  createCanonicalTargetSecretSourceJson,
  parseCanonicalTargetSecretSourceJson,
  parseTargetSecretSourceOpaqueHandle
} from "./targetSecretSourceRecordCommon.js";

export const TARGET_SECRET_SOURCE_GRANT_RECORD_VERSION = "spawnfile.auth.target-secret.grant.v1" as const;
export const TARGET_SECRET_SOURCE_REDEMPTION_RECORD_VERSION = "spawnfile.auth.target-secret.redemption.v1" as const;
export const TARGET_SECRET_SOURCE_REVOCATION_RECORD_VERSION = "spawnfile.auth.target-secret.revocation.v1" as const;
const GRANT_KEYS = ["descriptor_digest", "name", "publication_handle", "run_id", "scope", "selected_target", "source_handle", "source_version_handle", "version"] as const;
const GRANT_METADATA_KEYS = GRANT_KEYS.filter((key) => key !== "publication_handle");
const GRANT_INPUT_KEYS = GRANT_METADATA_KEYS.filter((key) => key !== "version");
const GRANT_COMMAND_INPUT_KEYS = GRANT_INPUT_KEYS.filter((key) => key !== "source_version_handle");
const REDEMPTION_KEYS = ["authorization", "publication_handle", "source_handle", "source_version_handle", "version"] as const;
const REDEMPTION_METADATA_KEYS = REDEMPTION_KEYS.filter((key) => key !== "publication_handle");
const REVOCATION_KEYS = ["kind", "publication_handle", "revocation_handle", "revoked_handle", "version"] as const;
const REVOCATION_METADATA_KEYS = REVOCATION_KEYS.filter((key) => key !== "publication_handle");
const PLACEHOLDER_HANDLE = "opaque_0000000000000000";
const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

export type TargetSecretSourceOpaqueHandle = ReturnType<typeof parseTargetSecretSourceOpaqueHandle>;
export type TargetSecretSourceEntropy = () => Uint8Array;
export type TargetSecretSourceGrantMetadata = Readonly<{
  descriptor_digest: string;
  name: string;
  run_id: string;
  scope: string;
  selected_target: SelectedTargetReceipt;
  source_handle: TargetSecretSourceOpaqueHandle;
  source_version_handle: TargetSecretSourceOpaqueHandle;
  version: typeof TARGET_SECRET_SOURCE_GRANT_RECORD_VERSION;
}>;
export type TargetSecretSourceGrantCommandInput = Readonly<
  Omit<TargetSecretSourceGrantMetadata, "source_version_handle" | "version">
>;
export type TargetSecretSourceGrantRecord = Readonly<TargetSecretSourceGrantMetadata & { publication_handle: TargetSecretSourceOpaqueHandle }>;
export type TargetSecretSourceRedemptionMetadata = Readonly<{
  authorization: TargetSecretSourceAuthorization;
  source_handle: TargetSecretSourceOpaqueHandle;
  source_version_handle: TargetSecretSourceOpaqueHandle;
  version: typeof TARGET_SECRET_SOURCE_REDEMPTION_RECORD_VERSION;
}>;
export type TargetSecretSourceRedemptionRecord = Readonly<TargetSecretSourceRedemptionMetadata & { publication_handle: TargetSecretSourceOpaqueHandle }>;
export type TargetSecretSourceRevocationMetadata = Readonly<{
  kind: "grant" | "version";
  revocation_handle: TargetSecretSourceOpaqueHandle;
  revoked_handle: TargetSecretSourceOpaqueHandle;
  version: typeof TARGET_SECRET_SOURCE_REVOCATION_RECORD_VERSION;
}>;
export type TargetSecretSourceRevocationRecord = Readonly<TargetSecretSourceRevocationMetadata & { publication_handle: TargetSecretSourceOpaqueHandle }>;
export type TargetSecretSourceGrantRecordBytes = Uint8Array & { readonly __brand: "TargetSecretSourceGrantRecordBytes" };
export type TargetSecretSourceRedemptionRecordBytes = Uint8Array & { readonly __brand: "TargetSecretSourceRedemptionRecordBytes" };
export type TargetSecretSourceRevocationRecordBytes = Uint8Array & { readonly __brand: "TargetSecretSourceRevocationRecordBytes" };

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const normalize = <T>(work: () => T): T => { try { return work(); } catch { return fail(); } };
const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
const defaultEntropy: TargetSecretSourceEntropy = (): Uint8Array => {
  const bytes = randomBytes(16); try { return Uint8Array.from(bytes); } finally { bytes.fill(0); }
};
const opaqueFromEntropy = (entropy: TargetSecretSourceEntropy): TargetSecretSourceOpaqueHandle => normalize(() => {
  const raw = entropy();
  if (!(raw instanceof Uint8Array) || raw.length < 8 || raw.length > 32) fail();
  const copy = Uint8Array.from(raw); const encoded = Buffer.from(copy);
  try { return parseTargetSecretSourceOpaqueHandle(`opaque_${encoded.toString("hex")}`); }
  finally { encoded.fill(0); copy.fill(0); }
});
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  assertOrdinaryJsonGraph(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>; const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail();
  return record;
};
export const parseTargetSecretSourceGrantCommandInput = (value: unknown): TargetSecretSourceGrantCommandInput => normalize(() => {
  const record = exact(value, GRANT_COMMAND_INPUT_KEYS);
  const selected = parseSelectedTargetReceipt(record.selected_target);
  const sourceHandle = parseTargetSecretSourceOpaqueHandle(record.source_handle);
  const authorization = parseTargetSecretSourceAuthorization({
    descriptorDigest: record.descriptor_digest, name: record.name, operationHandle: PLACEHOLDER_HANDLE,
    requestDigest: PLACEHOLDER_DIGEST, runId: record.run_id, scope: record.scope,
    selectedTarget: { fingerprint: selected.fingerprint, handle: selected.handle }, sourceHandle,
    version: "spawnfile.target-secret-source.authorization.v1"
  });
  if (sourceHandle === selected.handle) fail();
  return freeze({ descriptor_digest: authorization.descriptorDigest, name: authorization.name,
    run_id: authorization.runId, scope: authorization.scope, selected_target: freeze({ ...selected }),
    source_handle: sourceHandle });
});
const parseGrantMetadata = (value: unknown, expectedKeys: readonly string[] = GRANT_METADATA_KEYS): TargetSecretSourceGrantMetadata => normalize(() => {
  const record = exact(value, expectedKeys);
  if (expectedKeys === GRANT_METADATA_KEYS && record.version !== TARGET_SECRET_SOURCE_GRANT_RECORD_VERSION) fail();
  const command = parseTargetSecretSourceGrantCommandInput(Object.fromEntries(
    GRANT_COMMAND_INPUT_KEYS.map((key) => [key, record[key]])
  ));
  const sourceVersionHandle = parseTargetSecretSourceOpaqueHandle(record.source_version_handle);
  if (command.source_handle === sourceVersionHandle
    || sourceVersionHandle === command.selected_target.handle) fail();
  return freeze({ ...command,
    source_version_handle: sourceVersionHandle, version: TARGET_SECRET_SOURCE_GRANT_RECORD_VERSION });
});
const parseGrant = (value: unknown): TargetSecretSourceGrantRecord => normalize(() => {
  const record = exact(value, GRANT_KEYS);
  const metadata = parseGrantMetadata(Object.fromEntries(GRANT_METADATA_KEYS.map((key) => [key, record[key]])));
  const publicationHandle = parseTargetSecretSourceOpaqueHandle(record.publication_handle);
  if (publicationHandle === metadata.source_handle || publicationHandle === metadata.source_version_handle
    || publicationHandle === metadata.selected_target.handle) fail();
  return freeze({ publication_handle: publicationHandle, ...metadata });
});
const sameGrantAuthorization = (grant: TargetSecretSourceGrantMetadata, authorization: TargetSecretSourceAuthorization): boolean =>
  grant.descriptor_digest === authorization.descriptorDigest && grant.name === authorization.name && grant.run_id === authorization.runId
  && grant.scope === authorization.scope && grant.source_handle === authorization.sourceHandle
  && grant.selected_target.fingerprint === authorization.selectedTarget.fingerprint && grant.selected_target.handle === authorization.selectedTarget.handle;
export const createTargetSecretSourceGrantMetadata = (raw: unknown): TargetSecretSourceGrantMetadata =>
  normalize(() => parseGrantMetadata(raw, GRANT_INPUT_KEYS));
const parseRedemptionMetadata = (value: unknown): TargetSecretSourceRedemptionMetadata => normalize(() => {
  const record = exact(value, REDEMPTION_METADATA_KEYS);
  if (record.version !== TARGET_SECRET_SOURCE_REDEMPTION_RECORD_VERSION) fail();
  const authorization = parseTargetSecretSourceAuthorization(record.authorization);
  const sourceHandle = parseTargetSecretSourceOpaqueHandle(record.source_handle);
  const sourceVersionHandle = parseTargetSecretSourceOpaqueHandle(record.source_version_handle);
  if (new Set([
    sourceHandle, sourceVersionHandle, authorization.operationHandle, authorization.selectedTarget.handle
  ]).size !== 4) fail();
  return freeze({ authorization, source_handle: sourceHandle,
    source_version_handle: sourceVersionHandle, version: TARGET_SECRET_SOURCE_REDEMPTION_RECORD_VERSION });
});
const parseRedemption = (value: unknown): TargetSecretSourceRedemptionRecord => normalize(() => {
  const record = exact(value, REDEMPTION_KEYS);
  const metadata = parseRedemptionMetadata(Object.fromEntries(REDEMPTION_METADATA_KEYS.map((key) => [key, record[key]])));
  const publicationHandle = parseTargetSecretSourceOpaqueHandle(record.publication_handle);
  if (publicationHandle === metadata.source_handle || publicationHandle === metadata.source_version_handle
    || publicationHandle === metadata.authorization.operationHandle
    || publicationHandle === metadata.authorization.selectedTarget.handle) fail();
  return freeze({ publication_handle: publicationHandle, ...metadata });
});
const parseRevocationMetadata = (value: unknown): TargetSecretSourceRevocationMetadata => normalize(() => {
  const record = exact(value, REVOCATION_METADATA_KEYS);
  if (record.version !== TARGET_SECRET_SOURCE_REVOCATION_RECORD_VERSION || (record.kind !== "grant" && record.kind !== "version")) fail();
  const revoked = parseTargetSecretSourceOpaqueHandle(record.revoked_handle); const handle = parseTargetSecretSourceOpaqueHandle(record.revocation_handle);
  if (revoked === handle) fail();
  return freeze({ kind: record.kind as "grant" | "version", revoked_handle: revoked, revocation_handle: handle, version: TARGET_SECRET_SOURCE_REVOCATION_RECORD_VERSION });
});
const parseRevocation = (value: unknown): TargetSecretSourceRevocationRecord => normalize(() => {
  const record = exact(value, REVOCATION_KEYS);
  const metadata = parseRevocationMetadata(Object.fromEntries(REVOCATION_METADATA_KEYS.map((key) => [key, record[key]])));
  const publicationHandle = parseTargetSecretSourceOpaqueHandle(record.publication_handle);
  if (publicationHandle === metadata.revoked_handle || publicationHandle === metadata.revocation_handle) fail();
  return freeze({ publication_handle: publicationHandle, ...metadata });
});

export const createTargetSecretSourceGrantRecordBytes = (raw: unknown, options: { readonly publicationEntropy?: TargetSecretSourceEntropy } = {}): {
  readonly private_bytes: TargetSecretSourceGrantRecordBytes; readonly private_metadata: TargetSecretSourceGrantRecord; readonly metadata: TargetSecretSourceGrantMetadata;
} => normalize(() => {
  const input = createTargetSecretSourceGrantMetadata(raw);
  const metadata = freeze(input);
  const publicationHandle = opaqueFromEntropy(options.publicationEntropy ?? defaultEntropy);
  if (publicationHandle === metadata.source_handle || publicationHandle === metadata.source_version_handle
    || publicationHandle === metadata.selected_target.handle) fail();
  const privateMetadata = freeze({ publication_handle: publicationHandle, ...metadata });
  return { private_bytes: createCanonicalTargetSecretSourceJson(privateMetadata) as TargetSecretSourceGrantRecordBytes, private_metadata: privateMetadata, metadata };
});
export const parseTargetSecretSourceGrantRecordBytes = (raw: Uint8Array, expectedLeafHandle: TargetSecretSourceOpaqueHandle): TargetSecretSourceGrantRecord => normalize(() => {
  const expected = parseTargetSecretSourceOpaqueHandle(expectedLeafHandle); const grant = parseTargetSecretSourceGrantRecordBytesForPublication(raw);
  if (grant.source_handle !== expected) fail(); return grant;
});
export const parseTargetSecretSourceGrantRecordBytesForPublication = (raw: Uint8Array): TargetSecretSourceGrantRecord =>
  normalize(() => parseGrant(parseCanonicalTargetSecretSourceJson(raw)));
export const createTargetSecretSourceRedemptionMetadata = (
  grant: TargetSecretSourceGrantMetadata,
  authorization: TargetSecretSourceAuthorization
): TargetSecretSourceRedemptionMetadata => normalize(() => {
  const parsedGrant = parseGrantMetadata(grant); const parsedAuthorization = parseTargetSecretSourceAuthorization(authorization);
  if (!sameGrantAuthorization(parsedGrant, parsedAuthorization)) fail();
  return parseRedemptionMetadata({ authorization: parsedAuthorization, source_handle: parsedGrant.source_handle,
    source_version_handle: parsedGrant.source_version_handle, version: TARGET_SECRET_SOURCE_REDEMPTION_RECORD_VERSION });
});
export const createTargetSecretSourceRedemptionRecordBytes = (grant: TargetSecretSourceGrantMetadata, authorization: TargetSecretSourceAuthorization, options: { readonly publicationEntropy?: TargetSecretSourceEntropy } = {}): {
  readonly private_bytes: TargetSecretSourceRedemptionRecordBytes; readonly private_metadata: TargetSecretSourceRedemptionRecord; readonly metadata: TargetSecretSourceRedemptionMetadata;
} => normalize(() => {
  const metadata = createTargetSecretSourceRedemptionMetadata(grant, authorization);
  const publicationHandle = opaqueFromEntropy(options.publicationEntropy ?? defaultEntropy);
  if (publicationHandle === metadata.source_handle || publicationHandle === metadata.source_version_handle
    || publicationHandle === metadata.authorization.operationHandle
    || publicationHandle === metadata.authorization.selectedTarget.handle) fail();
  const privateMetadata = freeze({ publication_handle: publicationHandle, ...metadata });
  return { private_bytes: createCanonicalTargetSecretSourceJson(privateMetadata) as TargetSecretSourceRedemptionRecordBytes, private_metadata: privateMetadata, metadata };
});
export const parseTargetSecretSourceRedemptionRecordBytes = (raw: Uint8Array, expectedLeafHandle: TargetSecretSourceOpaqueHandle): TargetSecretSourceRedemptionRecord => normalize(() => {
  const expected = parseTargetSecretSourceOpaqueHandle(expectedLeafHandle); const redemption = parseTargetSecretSourceRedemptionRecordBytesForPublication(raw);
  if (redemption.source_handle !== expected) fail(); return redemption;
});
export const parseTargetSecretSourceRedemptionRecordBytesForPublication = (raw: Uint8Array): TargetSecretSourceRedemptionRecord =>
  normalize(() => parseRedemption(parseCanonicalTargetSecretSourceJson(raw)));
export const assertTargetSecretSourceRedemptionCorrelation = (redemption: TargetSecretSourceRedemptionMetadata, grant: TargetSecretSourceGrantMetadata): void => normalize(() => {
  const parsedRedemption = parseRedemptionMetadata(redemption); const parsedGrant = parseGrantMetadata(grant);
  if (parsedRedemption.source_handle !== parsedGrant.source_handle || parsedRedemption.source_version_handle !== parsedGrant.source_version_handle
    || !sameGrantAuthorization(parsedGrant, parsedRedemption.authorization)) fail();
});
export const createTargetSecretSourceRevocationRecordBytes = (raw: { readonly kind: "grant" | "version"; readonly revoked_handle: TargetSecretSourceOpaqueHandle }, options: { readonly entropy?: TargetSecretSourceEntropy; readonly publicationEntropy?: TargetSecretSourceEntropy } = {}): {
  readonly private_bytes: TargetSecretSourceRevocationRecordBytes; readonly private_metadata: TargetSecretSourceRevocationRecord; readonly metadata: TargetSecretSourceRevocationMetadata;
} => normalize(() => {
  const input = exact(raw, ["kind", "revoked_handle"]); if (input.kind !== "grant" && input.kind !== "version") fail();
  const revoked = parseTargetSecretSourceOpaqueHandle(input.revoked_handle); const revocation = opaqueFromEntropy(options.entropy ?? defaultEntropy);
  const publicationHandle = opaqueFromEntropy(options.publicationEntropy ?? defaultEntropy);
  if (revoked === revocation || publicationHandle === revoked || publicationHandle === revocation) fail();
  const metadata = freeze({ kind: input.kind as "grant" | "version", revoked_handle: revoked, revocation_handle: revocation, version: TARGET_SECRET_SOURCE_REVOCATION_RECORD_VERSION });
  const privateMetadata = freeze({ publication_handle: publicationHandle, ...metadata });
  return { private_bytes: createCanonicalTargetSecretSourceJson(privateMetadata) as TargetSecretSourceRevocationRecordBytes, private_metadata: privateMetadata, metadata };
});
export const parseTargetSecretSourceRevocationRecordBytes = (raw: Uint8Array, expectedLeafHandle: TargetSecretSourceOpaqueHandle): TargetSecretSourceRevocationRecord => normalize(() => {
  const expected = parseTargetSecretSourceOpaqueHandle(expectedLeafHandle); const revocation = parseTargetSecretSourceRevocationRecordBytesForPublication(raw);
  if (revocation.revoked_handle !== expected) fail(); return revocation;
});
export const parseTargetSecretSourceRevocationRecordBytesForPublication = (raw: Uint8Array): TargetSecretSourceRevocationRecord =>
  normalize(() => parseRevocation(parseCanonicalTargetSecretSourceJson(raw)));
