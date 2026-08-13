import { describe, expect, it, vi } from "vitest";

import { TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle } from "./targetSecretSourceRecordCommon.js";
import {
  createTargetSecretSourceGrantRecordBytes,
  createTargetSecretSourceRevocationRecordBytes,
  parseTargetSecretSourceRevocationRecordBytes
} from "./targetSecretSourceGrantRecords.js";
import { initializeTargetSecretSourceRevoke } from "./targetSecretSourceRevoke.js";
import {
  createTargetSecretSourceAliasRecordBytes,
  createTargetSecretSourceVersionRecordBytes,
  parseTargetSecretSourceVersionRecordBytes
} from "./targetSecretSourceVersionRecords.js";

const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const handle = (value: number) => parseTargetSecretSourceOpaqueHandle(`opaque_${value.toString(16).padStart(2, "0").repeat(16)}`);
const fixture = () => {
  const sourceVersion = createTargetSecretSourceVersionRecordBytes(new Uint8Array([1, 2, 3]), {
    entropy: entropy(1), publicationEntropy: entropy(2)
  });
  const alias = createTargetSecretSourceAliasRecordBytes(sourceVersion.metadata, {
    entropy: entropy(3), publicationEntropy: entropy(4)
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
  }, { publicationEntropy: entropy(5) });
  return {
    alias: alias.private_metadata,
    grant: grant.private_metadata,
    version: parseTargetSecretSourceVersionRecordBytes(sourceVersion.private_bytes, sourceVersion.metadata.source_version_handle)
  };
};

describe("targetSecretSourceRevoke", () => {
  it.each(["grant", "version"] as const)("durably revokes %s without exposing the private version handle", async (kind) => {
    const seeded = fixture();
    let durable: ReturnType<typeof parseTargetSecretSourceRevocationRecordBytes> | null = null;
    const published: Uint8Array[] = [];
    const reader = {
      readAlias: vi.fn(async () => seeded.alias),
      readGrant: vi.fn(async () => seeded.grant),
      readRevocation: vi.fn(async () => durable),
      readVersion: vi.fn(async () => seeded.version)
    };
    const service = await initializeTargetSecretSourceRevoke({
      entropy: entropy(6),
      publicationEntropy: entropy(7),
      publisher: {
        publishRevocation: vi.fn(async (bytes) => {
          published.push(bytes);
          const leaf = kind === "grant" ? seeded.alias.source_handle : seeded.alias.source_version_handle;
          durable = parseTargetSecretSourceRevocationRecordBytes(bytes, leaf);
        })
      },
      reader
    });

    const result = kind === "grant"
      ? await service.revokeGrant(seeded.alias.source_handle)
      : await service.revokeVersion(seeded.alias.source_handle);
    expect(result).toEqual({ kind, source_handle: seeded.alias.source_handle });
    expect(result).not.toHaveProperty("source_version_handle");
    expect(result).not.toHaveProperty("revocation_handle");
    expect(published[0]?.every((value) => value === 0)).toBe(true);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it("revokes a freshly authored version that has never received a grant", async () => {
    const seeded = fixture();
    let durable: ReturnType<typeof parseTargetSecretSourceRevocationRecordBytes> | null = null;
    const service = await initializeTargetSecretSourceRevoke({
      entropy: entropy(6),
      publicationEntropy: entropy(7),
      publisher: {
        publishRevocation: vi.fn(async (bytes) => {
          durable = parseTargetSecretSourceRevocationRecordBytes(bytes, seeded.alias.source_version_handle);
        })
      },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => null),
        readRevocation: vi.fn(async () => durable),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.revokeVersion(seeded.alias.source_handle)).resolves.toEqual({
      kind: "version", source_handle: seeded.alias.source_handle
    });
  });

  it("joins concurrent exact revocation and does not mint on later semantic replay", async () => {
    const seeded = fixture();
    let durable: ReturnType<typeof parseTargetSecretSourceRevocationRecordBytes> | null = null;
    const entropySource = vi.fn(entropy(6));
    const reader = {
      readAlias: vi.fn(async () => seeded.alias),
      readGrant: vi.fn(async () => seeded.grant),
      readRevocation: vi.fn(async () => durable),
      readVersion: vi.fn(async () => seeded.version)
    };
    const service = await initializeTargetSecretSourceRevoke({
      entropy: entropySource,
      publicationEntropy: entropy(7),
      publisher: {
        publishRevocation: vi.fn(async (bytes) => {
          durable = parseTargetSecretSourceRevocationRecordBytes(bytes, seeded.alias.source_handle);
        })
      },
      reader
    });
    await expect(Promise.all([
      service.revokeGrant(seeded.alias.source_handle),
      service.revokeGrant(seeded.alias.source_handle)
    ])).resolves.toHaveLength(2);
    const calls = entropySource.mock.calls.length;
    await expect(service.revokeGrant(seeded.alias.source_handle)).resolves.toEqual({
      kind: "grant", source_handle: seeded.alias.source_handle
    });
    expect(entropySource).toHaveBeenCalledTimes(calls);
  });

  it("rejects wrong-kind replay and a successful publisher without a durable record", async () => {
    for (const mode of ["wrong-kind", "missing"] as const) {
      const seeded = fixture();
      const wrong = createTargetSecretSourceRevocationRecordBytes({
        kind: "version", revoked_handle: seeded.alias.source_handle
      }, { entropy: entropy(6), publicationEntropy: entropy(7) });
      const service = await initializeTargetSecretSourceRevoke({
        entropy: entropy(6),
        publicationEntropy: entropy(7),
        publisher: { publishRevocation: vi.fn() },
        reader: {
          readAlias: vi.fn(async () => seeded.alias),
          readGrant: vi.fn(async () => seeded.grant),
          readRevocation: mode === "wrong-kind"
            ? vi.fn(async () => wrong.private_metadata)
            : vi.fn(async () => null),
          readVersion: vi.fn(async () => seeded.version)
        }
      });
      await expect(service.revokeGrant(seeded.alias.source_handle)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
    }
  });

  it.each([2, 4, 5])("rejects revocation private-handle collision with associated handle %s", async (collision) => {
    const seeded = fixture();
    const publishRevocation = vi.fn();
    const service = await initializeTargetSecretSourceRevoke({
      entropy: entropy(collision),
      publicationEntropy: entropy(8),
      publisher: { publishRevocation },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => seeded.grant),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.revokeGrant(seeded.alias.source_handle)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(publishRevocation).not.toHaveBeenCalled();
  });

  it.each(["revocation", "publication"] as const)("rejects new %s handle collision with selected target", async (field) => {
    const seeded = fixture();
    const publishRevocation = vi.fn();
    const service = await initializeTargetSecretSourceRevoke({
      entropy: entropy(field === "revocation" ? 9 : 6),
      publicationEntropy: entropy(field === "publication" ? 9 : 7),
      publisher: { publishRevocation },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => seeded.grant),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.revokeGrant(seeded.alias.source_handle)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(publishRevocation).not.toHaveBeenCalled();
  });

  it.each(["revocation", "publication"] as const)("rejects existing %s handle collision with selected target", async (field) => {
    const seeded = fixture();
    const existing = createTargetSecretSourceRevocationRecordBytes({
      kind: "grant", revoked_handle: seeded.alias.source_handle
    }, {
      entropy: entropy(field === "revocation" ? 9 : 6),
      publicationEntropy: entropy(field === "publication" ? 9 : 7)
    });
    const service = await initializeTargetSecretSourceRevoke({
      publisher: { publishRevocation: vi.fn() },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => seeded.grant),
        readRevocation: vi.fn(async () => existing.private_metadata),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.revokeGrant(seeded.alias.source_handle)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it("rejects corrupt alias/grant correlation before publishing", async () => {
    const seeded = fixture();
    const publishRevocation = vi.fn();
    const service = await initializeTargetSecretSourceRevoke({
      publisher: { publishRevocation },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => ({ ...seeded.grant, source_version_handle: handle(8) })),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(service.revokeGrant(seeded.alias.source_handle)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(publishRevocation).not.toHaveBeenCalled();
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });
});
