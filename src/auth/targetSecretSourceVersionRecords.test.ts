import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { TARGET_SECRET_SOURCE_ERROR, createCanonicalTargetSecretSourceJson } from "./targetSecretSourceRecordCommon.js";
import {
  TARGET_SECRET_SOURCE_ALIAS_RECORD_VERSION,
  TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION,
  assertTargetSecretSourceAliasCorrelation,
  createTargetSecretSourceAliasRecordBytes,
  createTargetSecretSourceVersionRecordBytes,
  parseTargetSecretSourceAliasRecordBytes,
  parseTargetSecretSourceVersionRecordBytes
} from "./targetSecretSourceVersionRecords.js";

const entropy = (...values: number[]) => {
  let index = 0;
  return (): Uint8Array => new Uint8Array(16).fill(values[index++] ?? (() => { throw new Error("entropy exhausted"); })());
};
const opaque = (value: number): string => `opaque_${value.toString(16).padStart(2, "0").repeat(16)}`;

describe("targetSecretSourceVersionRecords", () => {
  it("stores the sentinel only recoverably inside the version payload", () => {
    const sentinel = "TARGET_SECRET_SENTINEL_NEVER_REFLECT";
    const version = createTargetSecretSourceVersionRecordBytes(new TextEncoder().encode(sentinel), {
      entropy: entropy(1), publicationEntropy: entropy(2)
    });
    const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, {
      entropy: entropy(3), publicationEntropy: entropy(4)
    });
    const parsed = parseTargetSecretSourceVersionRecordBytes(version.private_bytes, version.metadata.source_version_handle);
    expect(new TextDecoder().decode(parsed.secret)).toBe(sentinel);
    expect(version.private_metadata.publication_handle).toBe(opaque(2));
    expect(alias.private_metadata.publication_handle).toBe(opaque(4));
    expect(parsed.publication_handle).toBe(version.private_metadata.publication_handle);
    expect(JSON.stringify(version.metadata)).not.toContain(sentinel);
    expect(JSON.stringify(alias.metadata)).not.toContain(sentinel);
    expect(Buffer.from(alias.private_bytes).toString("utf8")).not.toContain(sentinel);
    expect(version.metadata).not.toHaveProperty("publication_handle");
    expect(alias.metadata).not.toHaveProperty("publication_handle");
    expect(Buffer.from(alias.private_bytes).toString("utf8")).toContain(`"publication_handle":"${opaque(4)}"`);
    expect(Object.isFrozen(version.metadata)).toBe(true);
    expect(Object.isFrozen(version.private_metadata)).toBe(true);
    expect(Object.isFrozen(alias.metadata)).toBe(true);
    expect(Object.isFrozen(alias.private_metadata)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("mints both private handles independently and rejects either collision", () => {
    const version = createTargetSecretSourceVersionRecordBytes(new Uint8Array([1]), {
      entropy: entropy(3), publicationEntropy: entropy(4)
    });
    const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, {
      entropy: entropy(5), publicationEntropy: entropy(6)
    });
    expect(version.metadata.source_version_handle).toBe(opaque(3));
    expect(version.private_metadata.publication_handle).toBe(opaque(4));
    expect(alias.metadata.source_handle).toBe(opaque(5));
    expect(alias.metadata.source_version_handle).toBe(version.metadata.source_version_handle);
    expect(alias.private_metadata.publication_handle).toBe(opaque(6));
    expect(() => createTargetSecretSourceAliasRecordBytes(version.metadata, {
      entropy: entropy(3), publicationEntropy: entropy(7)
    }))
      .toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceAliasRecordBytes(version.metadata, {
      entropy: entropy(7), publicationEntropy: entropy(3)
    })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceAliasRecordBytes(version.metadata, {
      entropy: entropy(7), publicationEntropy: entropy(7)
    })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => createTargetSecretSourceVersionRecordBytes(new Uint8Array([1]), {
      entropy: entropy(6), publicationEntropy: entropy(6)
    })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("independently caps secret encoding and decoded version payloads at 32,768 bytes", () => {
    const tooLarge = new Uint8Array(32_769).fill(1);
    expect(() => createTargetSecretSourceVersionRecordBytes(tooLarge, { entropy: entropy(12) }))
      .toThrowError(TARGET_SECRET_SOURCE_ERROR);
    const sourceVersionHandle = opaque(13);
    const oversizedPayload = createCanonicalTargetSecretSourceJson({
      publication_handle: opaque(14),
      secret: Buffer.from(tooLarge).toString("base64"),
      source_version_handle: sourceVersionHandle,
      version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION
    });
    expect(() => parseTargetSecretSourceVersionRecordBytes(oversizedPayload, sourceVersionHandle as never))
      .toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("requires exact leaves and record versions", () => {
    const version = createTargetSecretSourceVersionRecordBytes(new Uint8Array([1, 2]), {
      entropy: entropy(5), publicationEntropy: entropy(15)
    });
    const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, { entropy: entropy(6) });
    const wrongVersion = createCanonicalTargetSecretSourceJson({
      publication_handle: version.private_metadata.publication_handle,
      secret: Buffer.from([1, 2]).toString("base64"), source_version_handle: version.metadata.source_version_handle, version: "wrong"
    });
    const missingPublication = createCanonicalTargetSecretSourceJson({
      secret: Buffer.from([1, 2]).toString("base64"),
      source_version_handle: version.metadata.source_version_handle,
      version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION
    });
    const wrongPublication = createCanonicalTargetSecretSourceJson({
      publication_handle: "invalid",
      secret: Buffer.from([1, 2]).toString("base64"),
      source_version_handle: version.metadata.source_version_handle,
      version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION
    });
    const wrongAliasVersion = createCanonicalTargetSecretSourceJson({
      publication_handle: alias.private_metadata.publication_handle,
      source_handle: alias.metadata.source_handle, source_version_handle: version.metadata.source_version_handle, version: "wrong"
    });
    const missingAliasPublication = createCanonicalTargetSecretSourceJson({
      source_handle: alias.metadata.source_handle,
      source_version_handle: version.metadata.source_version_handle,
      version: TARGET_SECRET_SOURCE_ALIAS_RECORD_VERSION
    });
    const invalidAliasPublication = createCanonicalTargetSecretSourceJson({
      publication_handle: "invalid",
      source_handle: alias.metadata.source_handle,
      source_version_handle: version.metadata.source_version_handle,
      version: TARGET_SECRET_SOURCE_ALIAS_RECORD_VERSION
    });
    expect(() => parseTargetSecretSourceVersionRecordBytes(version.private_bytes, alias.metadata.source_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceAliasRecordBytes(alias.private_bytes, version.metadata.source_version_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceVersionRecordBytes(wrongVersion, version.metadata.source_version_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceVersionRecordBytes(missingPublication, version.metadata.source_version_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceVersionRecordBytes(wrongPublication, version.metadata.source_version_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceAliasRecordBytes(wrongAliasVersion, alias.metadata.source_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceAliasRecordBytes(missingAliasPublication, alias.metadata.source_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    expect(() => parseTargetSecretSourceAliasRecordBytes(invalidAliasPublication, alias.metadata.source_handle)).toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("rejects hostile version metadata before property reads", () => {
    const version = createTargetSecretSourceVersionRecordBytes(new Uint8Array([9]), { entropy: entropy(7) });
    const hostileProxy = new Proxy({}, { get: () => { throw new Error("get executed"); } });
    const accessor = {};
    Object.defineProperty(accessor, "source_version_handle", { enumerable: true, get: () => version.metadata.source_version_handle });
    Object.defineProperty(accessor, "version", { enumerable: true, value: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION });
    const nonEnumerable = { source_version_handle: version.metadata.source_version_handle, version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION };
    Object.defineProperty(nonEnumerable, "version", { enumerable: false, value: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION });
    for (const metadata of [hostileProxy, accessor, nonEnumerable]) {
      expect(() => createTargetSecretSourceAliasRecordBytes(metadata as never, { entropy: entropy(8) })).toThrowError(TARGET_SECRET_SOURCE_ERROR);
    }
    expect(() => createTargetSecretSourceAliasRecordBytes(version.private_metadata as never, { entropy: entropy(8) }))
      .toThrowError(TARGET_SECRET_SOURCE_ERROR);
  });

  it("isolates input and parsed secret bytes, and normalizes sentinel-bearing failures", () => {
    const sentinel = "TARGET_SECRET_SENTINEL_NEVER_REFLECT";
    const input = new Uint8Array([1, 2, 3]);
    const version = createTargetSecretSourceVersionRecordBytes(input, { entropy: entropy(9) });
    input[0] = 99;
    const first = parseTargetSecretSourceVersionRecordBytes(version.private_bytes, version.metadata.source_version_handle);
    const second = parseTargetSecretSourceVersionRecordBytes(version.private_bytes, version.metadata.source_version_handle);
    first.secret[0] = 88;
    expect(second.secret).toEqual(new Uint8Array([1, 2, 3]));
    try { parseTargetSecretSourceVersionRecordBytes(version.private_bytes, `opaque_${sentinel}` as never); } catch (error) {
      expect(String(error)).toBe(`Error: ${TARGET_SECRET_SOURCE_ERROR}`);
      expect(String(error)).not.toContain(sentinel);
    }
  });

  it("parses and correlates the exact opaque alias mapping", () => {
    const version = createTargetSecretSourceVersionRecordBytes(new Uint8Array([1]), { entropy: entropy(10) });
    const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, { entropy: entropy(11) });
    const parsed = parseTargetSecretSourceAliasRecordBytes(alias.private_bytes, alias.metadata.source_handle);
    expect(parsed).toEqual(alias.private_metadata);
    expect(parsed.publication_handle).not.toBe(parsed.source_handle);
    expect(parsed.publication_handle).not.toBe(parsed.source_version_handle);
    expect(() => assertTargetSecretSourceAliasCorrelation(alias.metadata, version.metadata)).not.toThrow();
  });
});
