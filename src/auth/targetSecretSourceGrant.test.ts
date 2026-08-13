import { describe, expect, it, vi } from "vitest";

import {
  TARGET_SECRET_SOURCE_ERROR,
  parseTargetSecretSourceOpaqueHandle
} from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceGrant, type TargetSecretSourceGrantInput } from "./targetSecretSourceGrant.js";
import {
  createTargetSecretSourceGrantRecordBytes,
  parseTargetSecretSourceGrantRecordBytes
} from "./targetSecretSourceGrantRecords.js";
import {
  createTargetSecretSourceAliasRecordBytes,
  createTargetSecretSourceVersionRecordBytes,
  parseTargetSecretSourceVersionRecordBytes
} from "./targetSecretSourceVersionRecords.js";

const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const opaque = (value: number): ReturnType<typeof parseTargetSecretSourceOpaqueHandle> =>
  parseTargetSecretSourceOpaqueHandle(`opaque_${value.toString(16).padStart(2, "0").repeat(16)}`);
const records = () => {
  const version = createTargetSecretSourceVersionRecordBytes(new Uint8Array([9, 8, 7]), {
    entropy: entropy(1), publicationEntropy: entropy(2)
  });
  const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, {
    entropy: entropy(3), publicationEntropy: entropy(4)
  });
  return { alias: alias.private_metadata, version: parseTargetSecretSourceVersionRecordBytes(version.private_bytes, version.metadata.source_version_handle) };
};
const input = (changes: Partial<TargetSecretSourceGrantInput> = {}): TargetSecretSourceGrantInput => ({
  descriptor_digest: `sha256:${"a".repeat(64)}`,
  name: "api-token",
  run_id: "run-1",
  scope: "world",
  selected_target: {
    fingerprint: `sha256:${"b".repeat(32)}`,
    handle: opaque(9),
    version: "spawnfile.target-resource.selected-target.v1"
  },
  source_handle: opaque(3),
  ...changes
});

describe("targetSecretSourceGrant", () => {
  it("publishes one grant and returns only its existing public source handle", async () => {
    const seeded = records();
    const published: Uint8Array[] = [];
    let durable: ReturnType<typeof parseTargetSecretSourceGrantRecordBytes> | null = null;
    const publishGrant = vi.fn(async (bytes: Uint8Array) => {
      published.push(bytes);
      durable = parseTargetSecretSourceGrantRecordBytes(bytes, seeded.alias.source_handle);
    });
    const reader = {
      readAlias: vi.fn(async () => seeded.alias),
      readGrant: vi.fn(async () => durable),
      readRevocation: vi.fn(async () => null),
      readVersion: vi.fn(async () => seeded.version)
    };
    const service = await initializeTargetSecretSourceGrant({
      publicationEntropy: entropy(5), publisher: { publishGrant }, reader
    });

    const result = await service.grantSource(input());
    expect(result).toEqual({ source_handle: opaque(3) });
    expect(result).not.toHaveProperty("source_version_handle");
    expect(result).not.toHaveProperty("publication_handle");
    expect(publishGrant).toHaveBeenCalledOnce();
    expect(published[0]?.every((value) => value === 0)).toBe(true);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it("joins exact replay without republishing and rejects a different immutable claim", async () => {
    const seeded = records();
    const expected = createTargetSecretSourceGrantRecordBytes({
      ...input(), source_version_handle: seeded.alias.source_version_handle
    }, { publicationEntropy: entropy(6) });
    const publishGrant = vi.fn();
    const reader = {
      readAlias: vi.fn(async () => seeded.alias),
      readGrant: vi.fn(async () => expected.private_metadata),
      readRevocation: vi.fn(async () => null),
      readVersion: vi.fn(async () => seeded.version)
    };
    const replayEntropy = vi.fn(() => { throw new Error("must not mint on replay"); });
    const service = await initializeTargetSecretSourceGrant({
      publicationEntropy: replayEntropy, publisher: { publishGrant }, reader
    });

    await expect(service.grantSource(input())).resolves.toEqual({ source_handle: opaque(3) });
    expect(publishGrant).not.toHaveBeenCalled();
    expect(replayEntropy).not.toHaveBeenCalled();
    const different = { ...expected.private_metadata, name: "different" };
    reader.readGrant.mockResolvedValue(different as never);
    await expect(service.grantSource(input())).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("joins an identical winner after a publish conflict", async () => {
    const seeded = records();
    const winner = createTargetSecretSourceGrantRecordBytes({
      ...input(), source_version_handle: seeded.alias.source_version_handle
    }, { publicationEntropy: entropy(6) });
    const readGrant = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner.private_metadata);
    const service = await initializeTargetSecretSourceGrant({
      publicationEntropy: entropy(7),
      publisher: { publishGrant: vi.fn(async () => { throw new Error("lost election"); }) },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant,
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.grantSource(input())).resolves.toEqual({ source_handle: opaque(3) });
  });

  it("rejects a successful publisher that did not durably publish the exact grant", async () => {
    const seeded = records();
    const service = await initializeTargetSecretSourceGrant({
      publicationEntropy: entropy(5),
      publisher: { publishGrant: vi.fn(async () => undefined) },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => null),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.grantSource(input())).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it.each(["publish", "join"] as const)("fails when revocation appears during %s admission", async (mode) => {
    const seeded = records();
    const winner = createTargetSecretSourceGrantRecordBytes({
      ...input(), source_version_handle: seeded.alias.source_version_handle
    }, { publicationEntropy: entropy(6) });
    const readGrant = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner.private_metadata);
    const readRevocation = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: "grant" })
      .mockResolvedValueOnce(null);
    const service = await initializeTargetSecretSourceGrant({
      publicationEntropy: entropy(6),
      publisher: {
        publishGrant: vi.fn(async () => {
          if (mode === "join") throw new Error("lost election");
        })
      },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant,
        readRevocation,
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.grantSource(input())).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it.each([2, 4])("rejects grant publication collision with private record handle %s before publishing", async (collision) => {
    const seeded = records();
    const publishGrant = vi.fn();
    const service = await initializeTargetSecretSourceGrant({
      publicationEntropy: entropy(collision),
      publisher: { publishGrant },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => null),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.grantSource(input())).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(publishGrant).not.toHaveBeenCalled();
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it.each(["grant", "version"] as const)("rejects a revoked %s before publishing", async (kind) => {
    const seeded = records();
    const publishGrant = vi.fn();
    const service = await initializeTargetSecretSourceGrant({
      publicationEntropy: entropy(5),
      publisher: { publishGrant },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => null),
        readRevocation: vi.fn(async (handle) => handle === (kind === "grant"
          ? seeded.alias.source_handle
          : seeded.alias.source_version_handle) ? { kind } as never : null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.grantSource(input())).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(publishGrant).not.toHaveBeenCalled();
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });
});
