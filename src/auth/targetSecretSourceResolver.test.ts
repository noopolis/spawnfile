import { describe, expect, it, vi } from "vitest";

import { createTargetSecretSourceAuthorization } from "../target/dockerSecretsAuthority.js";
import { TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle } from "./targetSecretSourceRecordCommon.js";
import {
  createTargetSecretSourceGrantRecordBytes,
  createTargetSecretSourceRedemptionRecordBytes,
  parseTargetSecretSourceRedemptionRecordBytes
} from "./targetSecretSourceGrantRecords.js";
import { initializeTargetSecretSourceResolver } from "./targetSecretSourceResolver.js";
import {
  createTargetSecretSourceAliasRecordBytes,
  createTargetSecretSourceVersionRecordBytes,
  parseTargetSecretSourceVersionRecordBytes
} from "./targetSecretSourceVersionRecords.js";

const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const handle = (value: number) => parseTargetSecretSourceOpaqueHandle(`opaque_${value.toString(16).padStart(2, "0").repeat(16)}`);
const fixture = () => {
  const sourceVersion = createTargetSecretSourceVersionRecordBytes(new Uint8Array([9, 8, 7]), {
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
  const authorization = createTargetSecretSourceAuthorization({
    descriptorDigest: grant.metadata.descriptor_digest,
    name: grant.metadata.name,
    operationHandle: handle(10),
    requestDigest: `sha256:${"c".repeat(64)}`,
    runId: grant.metadata.run_id,
    scope: grant.metadata.scope,
    selectedTarget: {
      fingerprint: grant.metadata.selected_target.fingerprint,
      handle: grant.metadata.selected_target.handle
    },
    sourceHandle: grant.metadata.source_handle
  });
  const grantMetadata = grant.metadata;
  return {
    alias: alias.private_metadata,
    authorization,
    grant: grant.private_metadata,
    grantMetadata,
    version: parseTargetSecretSourceVersionRecordBytes(
      sourceVersion.private_bytes,
      sourceVersion.metadata.source_version_handle
    )
  };
};

describe("targetSecretSourceResolver", () => {
  it("rejects hostile authorization before any private read or publication", async () => {
    const readAlias = vi.fn();
    const publishRedemption = vi.fn();
    const resolver = await initializeTargetSecretSourceResolver({
      publisher: { publishRedemption },
      reader: {
        readAlias,
        readGrant: vi.fn(),
        readRedemption: vi.fn(),
        readRevocation: vi.fn(),
        readVersion: vi.fn()
      }
    });
    const hostile = new Proxy({}, { get: () => { throw new Error("sentinel"); } });
    await expect(resolver.resolve({ authorization: hostile as never })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(readAlias).not.toHaveBeenCalled();
    expect(publishRedemption).not.toHaveBeenCalled();
  });

  it("publishes the first redemption and transfers only owned secret bytes through the unchanged seam", async () => {
    const seeded = fixture();
    let durable: ReturnType<typeof parseTargetSecretSourceRedemptionRecordBytes> | null = null;
    const published: Uint8Array[] = [];
    const reader = {
      readAlias: vi.fn(async () => seeded.alias),
      readGrant: vi.fn(async () => seeded.grant),
      readRedemption: vi.fn(async () => durable),
      readRevocation: vi.fn(async () => null),
      readVersion: vi.fn(async () => seeded.version)
    };
    const resolver = await initializeTargetSecretSourceResolver({
      publicationEntropy: entropy(6),
      publisher: {
        publishRedemption: vi.fn(async (bytes) => {
          published.push(bytes);
          durable = parseTargetSecretSourceRedemptionRecordBytes(bytes, seeded.alias.source_handle);
        })
      },
      reader
    });

    const result = await resolver.resolve({ authorization: seeded.authorization });
    expect(result.authorization).toEqual(seeded.authorization);
    expect(result.sourceVersionHandle).toBe(seeded.alias.source_version_handle);
    expect(result.value).toEqual(new Uint8Array([9, 8, 7]));
    expect(published[0]?.every((value) => value === 0)).toBe(true);
    result.value.fill(0);
  });

  it("replays the exact first claim before entropy and rejects every different authorization", async () => {
    const seeded = fixture();
    const redemption = createTargetSecretSourceRedemptionRecordBytes(seeded.grantMetadata, seeded.authorization, {
      publicationEntropy: entropy(6)
    });
    const publicationEntropy = vi.fn(() => { throw new Error("must not mint on replay"); });
    const reader = {
      readAlias: vi.fn(async () => seeded.alias),
      readGrant: vi.fn(async () => seeded.grant),
      readRedemption: vi.fn(async () => redemption.private_metadata),
      readRevocation: vi.fn(async () => null),
      readVersion: vi.fn(async () => seeded.version)
    };
    const resolver = await initializeTargetSecretSourceResolver({
      publicationEntropy,
      publisher: { publishRedemption: vi.fn() },
      reader
    });
    const replay = await resolver.resolve({ authorization: seeded.authorization });
    expect(replay.value).toEqual(new Uint8Array([9, 8, 7]));
    expect(publicationEntropy).not.toHaveBeenCalled();
    replay.value.fill(0);

    const changed = createTargetSecretSourceAuthorization({
      ...seeded.authorization,
      requestDigest: `sha256:${"d".repeat(64)}`
    });
    await expect(resolver.resolve({ authorization: changed })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it("requires a durable exact redemption after either publisher success or failure", async () => {
    for (const throws of [false, true]) {
      const seeded = fixture();
      const winner = createTargetSecretSourceRedemptionRecordBytes(seeded.grantMetadata, seeded.authorization, {
        publicationEntropy: entropy(6)
      });
      const readRedemption = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(throws ? winner.private_metadata : null);
      const resolver = await initializeTargetSecretSourceResolver({
        publicationEntropy: entropy(6),
        publisher: { publishRedemption: vi.fn(async () => { if (throws) throw new Error("lost election"); }) },
        reader: {
          readAlias: vi.fn(async () => seeded.alias),
          readGrant: vi.fn(async () => seeded.grant),
          readRedemption,
          readRevocation: vi.fn(async () => null),
          readVersion: vi.fn(async () => seeded.version)
        }
      });
      if (throws) {
        const result = await resolver.resolve({ authorization: seeded.authorization });
        result.value.fill(0);
      } else {
        await expect(resolver.resolve({ authorization: seeded.authorization })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
        expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
      }
    }
  });

  it("honors abort and revocation both before admission and immediately before return", async () => {
    const pre = fixture();
    const aborted = new AbortController();
    aborted.abort();
    const readAlias = vi.fn();
    const preResolver = await initializeTargetSecretSourceResolver({
      publisher: { publishRedemption: vi.fn() },
      reader: {
        readAlias,
        readGrant: vi.fn(),
        readRedemption: vi.fn(),
        readRevocation: vi.fn(),
        readVersion: vi.fn()
      }
    });
    await expect(preResolver.resolve({ authorization: pre.authorization, signal: aborted.signal }))
      .rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(readAlias).not.toHaveBeenCalled();

    const late = fixture();
    const winner = createTargetSecretSourceRedemptionRecordBytes(late.grantMetadata, late.authorization, {
      publicationEntropy: entropy(6)
    });
    const revocations = vi.fn()
      .mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: "grant" }).mockResolvedValueOnce(null);
    const lateResolver = await initializeTargetSecretSourceResolver({
      publicationEntropy: entropy(6),
      publisher: { publishRedemption: vi.fn() },
      reader: {
        readAlias: vi.fn(async () => late.alias),
        readGrant: vi.fn(async () => late.grant),
        readRedemption: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner.private_metadata),
        readRevocation: revocations,
        readVersion: vi.fn(async () => late.version)
      }
    });
    await expect(lateResolver.resolve({ authorization: late.authorization })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(late.version.secret.every((value) => value === 0)).toBe(true);
  });

  it("fails and clears the secret when aborted after durable redemption but before return", async () => {
    const seeded = fixture();
    const controller = new AbortController();
    let durable: ReturnType<typeof parseTargetSecretSourceRedemptionRecordBytes> | null = null;
    const resolver = await initializeTargetSecretSourceResolver({
      publicationEntropy: entropy(6),
      publisher: {
        publishRedemption: vi.fn(async (bytes) => {
          durable = parseTargetSecretSourceRedemptionRecordBytes(bytes, seeded.alias.source_handle);
          controller.abort();
        })
      },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => seeded.grant),
        readRedemption: vi.fn(async () => durable),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(resolver.resolve({ authorization: seeded.authorization, signal: controller.signal }))
      .rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it.each([2, 4, 5])("rejects redemption publication collision with associated private handle %s", async (collision) => {
    const seeded = fixture();
    const publishRedemption = vi.fn();
    const resolver = await initializeTargetSecretSourceResolver({
      publicationEntropy: entropy(collision),
      publisher: { publishRedemption },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => seeded.grant),
        readRedemption: vi.fn(async () => null),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(resolver.resolve({ authorization: seeded.authorization })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(publishRedemption).not.toHaveBeenCalled();
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it.each([
    ["existing", 2], ["existing", 4], ["existing", 5],
    ["joined", 2], ["joined", 4], ["joined", 5]
  ] as const)("rejects %s redemption whose publication handle collides with associated private handle %s", async (path, collision) => {
    const seeded = fixture();
    const colliding = createTargetSecretSourceRedemptionRecordBytes(
      seeded.grantMetadata,
      seeded.authorization,
      { publicationEntropy: entropy(collision) }
    );
    const readRedemption = path === "existing"
      ? vi.fn(async () => colliding.private_metadata)
      : vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(colliding.private_metadata);
    const resolver = await initializeTargetSecretSourceResolver({
      publicationEntropy: entropy(6),
      publisher: { publishRedemption: vi.fn(async () => { throw new Error("lost election"); }) },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => seeded.grant),
        readRedemption,
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => seeded.version)
      }
    });
    await expect(resolver.resolve({ authorization: seeded.authorization })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(seeded.version.secret.every((value) => value === 0)).toBe(true);
  });

  it("rejects a parser-valid loaded record set whose private version handle equals the public source handle", async () => {
    const seeded = fixture();
    const collidingVersion = {
      ...seeded.version,
      publication_handle: seeded.alias.source_handle
    };
    const resolver = await initializeTargetSecretSourceResolver({
      publicationEntropy: entropy(6),
      publisher: { publishRedemption: vi.fn() },
      reader: {
        readAlias: vi.fn(async () => seeded.alias),
        readGrant: vi.fn(async () => seeded.grant),
        readRedemption: vi.fn(async () => null),
        readRevocation: vi.fn(async () => null),
        readVersion: vi.fn(async () => collidingVersion)
      }
    });
    await expect(resolver.resolve({ authorization: seeded.authorization })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(collidingVersion.secret.every((value) => value === 0)).toBe(true);
  });
});
