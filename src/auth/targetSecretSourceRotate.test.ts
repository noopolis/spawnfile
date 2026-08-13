import { describe, expect, it, vi } from "vitest";

import { TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle } from "./targetSecretSourceRecordCommon.js";
import { createTargetSecretSourceGrantRecordBytes } from "./targetSecretSourceGrantRecords.js";
import { initializeTargetSecretSourceRotate } from "./targetSecretSourceRotate.js";
import {
  createTargetSecretSourceAliasRecordBytes,
  createTargetSecretSourceVersionRecordBytes,
  parseTargetSecretSourceVersionRecordBytes
} from "./targetSecretSourceVersionRecords.js";

const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const handle = (value: number) => parseTargetSecretSourceOpaqueHandle(`opaque_${value.toString(16).padStart(2, "0").repeat(16)}`);
const fixture = (base = 0, secret = new Uint8Array([1, 2, 3])) => {
  const version = createTargetSecretSourceVersionRecordBytes(secret, {
    entropy: entropy(base + 1), publicationEntropy: entropy(base + 2)
  });
  const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, {
    entropy: entropy(base + 3), publicationEntropy: entropy(base + 4)
  });
  const grant = createTargetSecretSourceGrantRecordBytes({
    descriptor_digest: `sha256:${"a".repeat(64)}`,
    name: "token",
    run_id: "run-1",
    scope: "world",
    selected_target: {
      fingerprint: `sha256:${"b".repeat(32)}`,
      handle: handle(9),
      version: "spawnfile.target-resource.selected-target.v1"
    },
    source_handle: alias.metadata.source_handle,
    source_version_handle: alias.metadata.source_version_handle
  }, { publicationEntropy: entropy(base + 5) });
  return {
    alias: alias.private_metadata,
    grant: grant.private_metadata,
    version: parseTargetSecretSourceVersionRecordBytes(version.private_bytes, version.metadata.source_version_handle)
  };
};

describe("targetSecretSourceRotate", () => {
  it("authors and grants a new source with the exact old binding while leaving the old source active", async () => {
    const seeded = fixture();
    const replacement = fixture(10, new Uint8Array([7, 7, 7]));
    const oldAlias = JSON.stringify(seeded.alias);
    const oldGrant = JSON.stringify(seeded.grant);
    const authoredBytes: Uint8Array[] = [];
    const authorVersion = vi.fn(async (secret: Uint8Array) => {
      authoredBytes.push(secret);
      return Object.freeze({ source_handle: replacement.alias.source_handle });
    });
    const grantSource = vi.fn(async () => Object.freeze({ source_handle: replacement.alias.source_handle }));
    const readRevocation = vi.fn(async () => null);
    const service = await initializeTargetSecretSourceRotate({
      author: { authorVersion },
      grant: { grantSource },
      reader: {
        readAlias: vi.fn(async (source) => source === seeded.alias.source_handle ? seeded.alias : replacement.alias),
        readGrant: vi.fn(async (source) => source === seeded.alias.source_handle ? seeded.grant : replacement.grant),
        readRevocation,
        readVersion: vi.fn(async (version) => version === seeded.alias.source_version_handle ? seeded.version : replacement.version)
      }
    });
    const callerSecret = new Uint8Array([7, 7, 7]);

    const result = await service.rotateSource({ secret: callerSecret, source_handle: seeded.alias.source_handle });
    expect(result).toEqual({ source_handle: replacement.alias.source_handle });
    expect(result).not.toHaveProperty("source_version_handle");
    expect(grantSource).toHaveBeenCalledWith({
      descriptor_digest: seeded.grant.descriptor_digest,
      name: seeded.grant.name,
      run_id: seeded.grant.run_id,
      scope: seeded.grant.scope,
      selected_target: seeded.grant.selected_target,
      source_handle: replacement.alias.source_handle
    });
    expect(callerSecret).toEqual(new Uint8Array([7, 7, 7]));
    expect(authoredBytes[0]?.every((value) => value === 0)).toBe(true);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
    expect(replacement.version.secret.every((value) => value === 0)).toBe(true);
    expect(JSON.stringify(seeded.alias)).toBe(oldAlias);
    expect(JSON.stringify(seeded.grant)).toBe(oldGrant);
    expect(readRevocation).toHaveBeenCalledTimes(6);
  });

  it.each(["author", "grant", "final-revocation"] as const)(
    "returns no handle and keeps owned buffers cleared when %s fails",
    async (failure) => {
      const seeded = fixture();
      const replacement = fixture(10, new Uint8Array([6, 6]));
      const authoredBytes: Uint8Array[] = [];
      const authorVersion = vi.fn(async (secret: Uint8Array) => {
        authoredBytes.push(secret);
        if (failure === "author") throw new Error("author failed");
        return Object.freeze({ source_handle: replacement.alias.source_handle });
      });
      const grantSource = vi.fn(async () => {
        if (failure === "grant") throw new Error("grant failed");
        return Object.freeze({ source_handle: replacement.alias.source_handle });
      });
      const readRevocation = failure === "final-revocation"
        ? vi.fn()
          .mockResolvedValueOnce(null).mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null).mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ kind: "grant" }).mockResolvedValueOnce(null)
        : vi.fn(async () => null);
      const service = await initializeTargetSecretSourceRotate({
        author: { authorVersion },
        grant: { grantSource },
        reader: {
          readAlias: vi.fn(async (source) => source === seeded.alias.source_handle ? seeded.alias : replacement.alias),
          readGrant: vi.fn(async (source) => source === seeded.alias.source_handle ? seeded.grant : replacement.grant),
          readRevocation,
          readVersion: vi.fn(async (version) => version === seeded.alias.source_version_handle ? seeded.version : replacement.version)
        }
      });
      let error: unknown;
      try {
        await service.rotateSource({ secret: new Uint8Array([6, 6]), source_handle: seeded.alias.source_handle });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toBe(`Error: ${TARGET_SECRET_SOURCE_ERROR}`);
      expect(String(error)).not.toContain(replacement.alias.source_handle);
      expect(authoredBytes.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
      expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
      if (failure === "final-revocation") expect(replacement.version.secret.every((value) => value === 0)).toBe(true);
    }
  );

  it("rejects an already-revoked old source before authoring", async () => {
    const seeded = fixture();
    const authorVersion = vi.fn();
    const service = await initializeTargetSecretSourceRotate({
      author: { authorVersion },
      grant: { grantSource: vi.fn() },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => seeded.grant),
        readRevocation: vi.fn(async () => ({ kind: "grant" } as never)),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.rotateSource({
      secret: new Uint8Array([5]),
      source_handle: seeded.alias.source_handle
    })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(authorVersion).not.toHaveBeenCalled();
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it("rejects unbounded secrets and a drifted grant result without exposing the authored handle", async () => {
    const seeded = fixture();
    const readAlias = vi.fn(async () => seeded.alias);
    const service = await initializeTargetSecretSourceRotate({
      author: { authorVersion: vi.fn(async () => ({ source_handle: handle(8) })) },
      grant: { grantSource: vi.fn(async () => ({ source_handle: handle(10) })) },
      reader: {
        readAlias,
        readGrant: vi.fn(async () => seeded.grant),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.rotateSource({ secret: new Uint8Array(), source_handle: seeded.alias.source_handle }))
      .rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(readAlias).not.toHaveBeenCalled();
    await expect(service.rotateSource({ secret: new Uint8Array([1]), source_handle: seeded.alias.source_handle }))
      .rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it.each(["author-not-persisted", "grant-not-persisted"] as const)(
    "proves durable new state when %s",
    async (failure) => {
      const seeded = fixture();
      const replacement = fixture(10);
      const service = await initializeTargetSecretSourceRotate({
        author: { authorVersion: vi.fn(async () => ({ source_handle: replacement.alias.source_handle })) },
        grant: { grantSource: vi.fn(async () => ({ source_handle: replacement.alias.source_handle })) },
        reader: {
          readAlias: vi.fn(async (source) => source === seeded.alias.source_handle
            ? seeded.alias
            : failure === "author-not-persisted" ? null : replacement.alias),
          readGrant: vi.fn(async (source) => source === seeded.alias.source_handle
            ? seeded.grant
            : failure === "grant-not-persisted" ? null : replacement.grant),
          readRevocation: vi.fn(async () => null),
          readVersion: vi.fn(async (version) => version === seeded.alias.source_version_handle
            ? seeded.version
            : replacement.version)
        }
      });
      await expect(service.rotateSource({
        secret: new Uint8Array([4]),
        source_handle: seeded.alias.source_handle
      })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
      if (failure === "grant-not-persisted") expect(replacement.version.secret.every((value) => value === 0)).toBe(false);
    }
  );

  it("rejects a durably persisted replacement with the wrong secret and clears both owned copies", async () => {
    const seeded = fixture();
    const replacement = fixture(10, new Uint8Array([9, 9]));
    const authoredBytes: Uint8Array[] = [];
    const service = await initializeTargetSecretSourceRotate({
      author: {
        authorVersion: vi.fn(async (secret) => {
          authoredBytes.push(secret);
          return { source_handle: replacement.alias.source_handle };
        })
      },
      grant: { grantSource: vi.fn(async () => ({ source_handle: replacement.alias.source_handle })) },
      reader: {
        readAlias: vi.fn(async (source) => source === seeded.alias.source_handle ? seeded.alias : replacement.alias),
        readGrant: vi.fn(async (source) => source === seeded.alias.source_handle ? seeded.grant : replacement.grant),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async (version) => version === seeded.alias.source_version_handle ? seeded.version : replacement.version)
      }
    });
    await expect(service.rotateSource({
      secret: new Uint8Array([8, 8]),
      source_handle: seeded.alias.source_handle
    })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(authoredBytes[0]?.every((value) => value === 0)).toBe(true);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
    expect(replacement.version.secret.every((value) => value === 0)).toBe(true);
  });

  it("rejects a malformed/grifter grant result before any new-state lookup", async () => {
    const seeded = fixture();
    let reads = 0;
    const grifter = Object.defineProperty({}, "source_handle", {
      enumerable: true,
      get: () => (++reads === 1 ? "malformed" : handle(8))
    });
    const readAlias = vi.fn(async () => seeded.alias);
    const service = await initializeTargetSecretSourceRotate({
      author: { authorVersion: vi.fn(async () => ({ source_handle: handle(8) })) },
      grant: { grantSource: vi.fn(async () => grifter as never) },
      reader: {
        readAlias,
        readGrant: vi.fn(async () => seeded.grant),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.rotateSource({
      secret: new Uint8Array([3]),
      source_handle: seeded.alias.source_handle
    })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(reads).toBe(1);
    expect(readAlias).toHaveBeenCalledTimes(1);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });
});
