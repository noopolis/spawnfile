import { describe, expect, it } from "vitest";

import { createTargetSecretSourceAuthorization } from "../target/dockerSecretsAuthority.js";
import { TARGET_SECRET_SOURCE_ERROR, createCanonicalTargetSecretSourceJson } from "./targetSecretSourceRecordCommon.js";
import {
  TARGET_SECRET_SOURCE_GRANT_RECORD_VERSION,
  TARGET_SECRET_SOURCE_REDEMPTION_RECORD_VERSION,
  TARGET_SECRET_SOURCE_REVOCATION_RECORD_VERSION,
  assertTargetSecretSourceRedemptionCorrelation,
  createTargetSecretSourceGrantMetadata,
  createTargetSecretSourceRedemptionMetadata,
  createTargetSecretSourceGrantRecordBytes,
  createTargetSecretSourceRedemptionRecordBytes,
  createTargetSecretSourceRevocationRecordBytes,
  parseTargetSecretSourceGrantRecordBytes,
  parseTargetSecretSourceGrantCommandInput,
  parseTargetSecretSourceRedemptionRecordBytes,
  parseTargetSecretSourceRevocationRecordBytes
} from "./targetSecretSourceGrantRecords.js";

const handle = (value: string): string => `opaque_${value.padEnd(16, "0")}`;
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const grantInput = () => ({ descriptor_digest: digest("a"), name: "token", run_id: "run-1", scope: "world",
  selected_target: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("target"), version: "spawnfile.target-resource.selected-target.v1" },
  source_handle: handle("source"), source_version_handle: handle("version") });
const authorization = (changes: Record<string, unknown> = {}) => ({ descriptorDigest: digest("a"), name: "token", operationHandle: handle("operation"),
  requestDigest: digest("c"), runId: "run-1", scope: "world", selectedTarget: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("target") }, sourceHandle: handle("source"),
  version: "spawnfile.target-secret-source.authorization.v1", ...changes });

describe("targetSecretSourceGrantRecords", () => {
  it("owns the exact public grant command grammar without private version fields", () => {
    const { source_version_handle: _privateVersion, ...publicInput } = grantInput();
    const parsed = parseTargetSecretSourceGrantCommandInput(publicInput);
    expect(parsed).toEqual(publicInput);
    expect(parsed).not.toHaveProperty("source_version_handle");
    expect(parsed).not.toHaveProperty("publication_handle");
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const hostile of [
      { ...publicInput, extra: true },
      { ...publicInput, source_version_handle: grantInput().source_version_handle }
    ]) expect(() => parseTargetSecretSourceGrantCommandInput(hostile)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    let reads = 0;
    const accessor = { ...publicInput };
    Object.defineProperty(accessor, "name", { enumerable: true, get: () => { reads += 1; return "token"; } });
    expect(() => parseTargetSecretSourceGrantCommandInput(accessor)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(reads).toBe(0);
    let proxyReads = 0;
    const proxy = new Proxy(publicInput, {
      get: (target, property, receiver) => {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => parseTargetSecretSourceGrantCommandInput(proxy)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(proxyReads).toBe(0);
  });

  it("validates publication-free grant metadata exactly and matches record construction", () => {
    const metadata = createTargetSecretSourceGrantMetadata(grantInput());
    const record = createTargetSecretSourceGrantRecordBytes(grantInput(), { publicationEntropy: entropy(9) });
    expect(metadata).toEqual(record.metadata);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(metadata).not.toHaveProperty("publication_handle");
    expect(() => createTargetSecretSourceGrantMetadata({ ...grantInput(), extra: true })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceGrantMetadata({ ...grantInput(), version: TARGET_SECRET_SOURCE_GRANT_RECORD_VERSION }))
      .toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("validates publication-free redemption metadata before entropy and matches record construction", () => {
    const grant = createTargetSecretSourceGrantRecordBytes(grantInput(), { publicationEntropy: entropy(8) });
    const parsedAuthorization = createTargetSecretSourceAuthorization(authorization() as never);
    const metadata = createTargetSecretSourceRedemptionMetadata(grant.metadata, parsedAuthorization);
    const record = createTargetSecretSourceRedemptionRecordBytes(grant.metadata, parsedAuthorization, {
      publicationEntropy: entropy(9)
    });
    expect(metadata).toEqual(record.metadata);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(metadata).not.toHaveProperty("publication_handle");
    expect(() => createTargetSecretSourceRedemptionMetadata(
      grant.metadata,
      { ...parsedAuthorization, requestDigest: digest("d") }
    )).not.toThrow();
    expect(() => createTargetSecretSourceRedemptionMetadata(
      grant.metadata,
      { ...parsedAuthorization, name: "other" }
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("uses caller-visible source_handle as the exact grant and redemption leaf", () => {
    const grant = createTargetSecretSourceGrantRecordBytes(grantInput(), { publicationEntropy: entropy(1) });
    const parsedGrant = parseTargetSecretSourceGrantRecordBytes(grant.private_bytes, grant.metadata.source_handle);
    const redemption = createTargetSecretSourceRedemptionRecordBytes(grant.metadata, authorization() as never, { publicationEntropy: entropy(2) });
    const parsedRedemption = parseTargetSecretSourceRedemptionRecordBytes(redemption.private_bytes, grant.metadata.source_handle);
    const revocation = createTargetSecretSourceRevocationRecordBytes({ kind: "grant", revoked_handle: grant.metadata.source_handle }, { entropy: entropy(3), publicationEntropy: entropy(4) });
    expect(parsedGrant.version).toBe(TARGET_SECRET_SOURCE_GRANT_RECORD_VERSION);
    expect(parsedRedemption.version).toBe(TARGET_SECRET_SOURCE_REDEMPTION_RECORD_VERSION);
    expect(parsedRedemption.source_handle).toBe(grant.metadata.source_handle);
    expect(parsedRedemption.authorization.operationHandle).toBe(handle("operation"));
    expect(parsedRedemption.authorization.requestDigest).toBe(digest("c"));
    expect(parseTargetSecretSourceRevocationRecordBytes(revocation.private_bytes, grant.metadata.source_handle).version).toBe(TARGET_SECRET_SOURCE_REVOCATION_RECORD_VERSION);
    expect(parsedGrant.publication_handle).toBe(grant.private_metadata.publication_handle);
    expect(parsedRedemption.publication_handle).toBe(redemption.private_metadata.publication_handle);
    expect(() => assertTargetSecretSourceRedemptionCorrelation(redemption.metadata, grant.metadata)).not.toThrow();
    for (const value of [grant.metadata, redemption.metadata, revocation.metadata]) expect(value).not.toHaveProperty("publication_handle");
  });

  it("rejects every grant-correlation drift and source-version substitution", () => {
    const grant = createTargetSecretSourceGrantRecordBytes(grantInput()).metadata;
    for (const changed of [
      { descriptorDigest: digest("d") }, { name: "other" }, { runId: "run-2" }, { scope: "other" }, { sourceHandle: handle("other") },
      { selectedTarget: { fingerprint: `sha256:${"e".repeat(32)}`, handle: handle("target") } }, { selectedTarget: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("other") } }
    ]) expect(() => createTargetSecretSourceRedemptionRecordBytes(grant, authorization(changed) as never)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    const redemption = createTargetSecretSourceRedemptionRecordBytes(grant, authorization() as never).metadata;
    const created = createTargetSecretSourceRedemptionRecordBytes(grant, authorization() as never, { publicationEntropy: entropy(5) });
    const versionDrift = { ...created.metadata, source_version_handle: handle("other") };
    expect(() => assertTargetSecretSourceRedemptionCorrelation(versionDrift as never, grant)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("keeps source, version, selected-target, and redemption-operation handle domains disjoint", () => {
    const base = grantInput();
    expect(() => createTargetSecretSourceGrantRecordBytes({
      ...base, source_handle: base.selected_target.handle
    })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceGrantRecordBytes({
      ...base, source_version_handle: base.selected_target.handle
    })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    const grant = createTargetSecretSourceGrantRecordBytes(base, { publicationEntropy: entropy(8) });
    for (const operationHandle of [
      grant.metadata.source_handle,
      grant.metadata.source_version_handle,
      grant.metadata.selected_target.handle
    ]) expect(() => createTargetSecretSourceRedemptionMetadata(
      grant.metadata,
      authorization({ operationHandle }) as never
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    const valid = createTargetSecretSourceRedemptionRecordBytes(
      grant.metadata,
      authorization() as never,
      { publicationEntropy: entropy(9) }
    );
    const loadedCollision = createCanonicalTargetSecretSourceJson({
      ...valid.private_metadata,
      authorization: {
        ...valid.private_metadata.authorization,
        operationHandle: valid.private_metadata.source_handle
      }
    });
    expect(() => parseTargetSecretSourceRedemptionRecordBytes(
      loadedCollision,
      valid.metadata.source_handle
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("requires expected source leaves, canonical versions, and bounded direct tombstones", () => {
    const created = createTargetSecretSourceGrantRecordBytes(grantInput());
    expect(() => parseTargetSecretSourceGrantRecordBytes(created.private_bytes, handle("wrong") as never)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceGrantRecordBytes({ ...grantInput(), source_handle: grantInput().source_version_handle })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceGrantRecordBytes({ ...grantInput(), selected_target: { ...grantInput().selected_target, version: "wrong" } })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    const wrongVersion = createCanonicalTargetSecretSourceJson({ ...created.private_metadata, version: "wrong" });
    expect(() => parseTargetSecretSourceGrantRecordBytes(wrongVersion, created.metadata.source_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceGrantRecordBytes(new Uint8Array([...created.private_bytes, 32]), created.metadata.source_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    const revoke = createTargetSecretSourceRevocationRecordBytes({ kind: "version", revoked_handle: created.metadata.source_version_handle }, { entropy: entropy(2) });
    expect(() => parseTargetSecretSourceRevocationRecordBytes(revoke.private_bytes, handle("wrong") as never)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceRevocationRecordBytes({ kind: "grant", revoked_handle: `opaque_${"03".repeat(16)}` as never }, { entropy: entropy(3) })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("requires independent private publication handles without leaking them through public metadata", () => {
    const grant = createTargetSecretSourceGrantRecordBytes(grantInput(), { publicationEntropy: entropy(6) });
    const redemption = createTargetSecretSourceRedemptionRecordBytes(grant.metadata, authorization() as never, { publicationEntropy: entropy(7) });
    const revocation = createTargetSecretSourceRevocationRecordBytes(
      { kind: "grant", revoked_handle: grant.metadata.source_handle },
      { entropy: entropy(8), publicationEntropy: entropy(9) }
    );
    for (const item of [grant, redemption, revocation]) {
      expect(item.private_metadata).toHaveProperty("publication_handle");
      expect(item.metadata).not.toHaveProperty("publication_handle");
      const text = new TextDecoder().decode(item.private_bytes);
      expect(text).toContain(`"publication_handle":"${item.private_metadata.publication_handle}"`);
    }
    expect(() => parseTargetSecretSourceGrantRecordBytes(
      createCanonicalTargetSecretSourceJson({ ...grant.metadata }), grant.metadata.source_handle
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceRedemptionRecordBytes(
      createCanonicalTargetSecretSourceJson({ ...redemption.metadata }), redemption.metadata.source_handle
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceRevocationRecordBytes(
      createCanonicalTargetSecretSourceJson({ ...revocation.metadata }), revocation.metadata.revoked_handle
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    const collidingSource = `opaque_${"0a".repeat(16)}`;
    const collisionGrantInput = { ...grantInput(), source_handle: collidingSource };
    expect(() => createTargetSecretSourceGrantRecordBytes(collisionGrantInput, { publicationEntropy: entropy(0x0a) })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    const collisionGrant = createTargetSecretSourceGrantRecordBytes(collisionGrantInput, { publicationEntropy: entropy(0x0b) });
    expect(() => createTargetSecretSourceRedemptionRecordBytes(
      collisionGrant.metadata,
      authorization({ sourceHandle: collidingSource }) as never,
      { publicationEntropy: entropy(0x0a) }
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceGrantRecordBytes({
      ...grantInput(),
      selected_target: { ...grantInput().selected_target, handle: `opaque_${"0c".repeat(16)}` }
    }, { publicationEntropy: entropy(0x0c) })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceRedemptionRecordBytes(
      grant.metadata,
      authorization({ operationHandle: `opaque_${"0d".repeat(16)}` }) as never,
      { publicationEntropy: entropy(0x0d) }
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceRevocationRecordBytes(
      { kind: "grant", revoked_handle: grant.metadata.source_handle },
      { entropy: entropy(10), publicationEntropy: entropy(10) }
    )).toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("rejects hostile/noncanonical records and never reflects a sentinel", () => {
    const sentinel = "TARGET_SECRET_SENTINEL_NEVER_REFLECT";
    const proxy = new Proxy({}, { get: () => { throw new Error(sentinel); } });
    const accessor = {};
    Object.defineProperty(accessor, "descriptor_digest", { enumerable: true, get: () => digest("a") });
    for (const raw of [proxy, accessor, { ...grantInput(), extra: true }]) expect(() => createTargetSecretSourceGrantRecordBytes(raw)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    try { createTargetSecretSourceGrantRecordBytes({ ...grantInput(), name: sentinel }); } catch (error) {
      expect(String(error)).toBe(`Error: ${TARGET_SECRET_SOURCE_ERROR}`); expect(String(error)).not.toContain(sentinel);
    }
  });
});
