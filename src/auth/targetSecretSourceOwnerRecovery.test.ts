import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTargetSecretSourceAuthorization } from "../target/dockerSecretsAuthority.js";
import {
  resolveTargetSecretGrantPath,
  resolveTargetSecretRedemptionPath,
  resolveTargetSecretRevocationPath
} from "./paths.js";
import { initializeTargetSecretSourceAuthor } from "./targetSecretSourceAuthor.js";
import { initializeTargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import { initializeTargetSecretSourceGrant, type TargetSecretSourceGrantInput } from "./targetSecretSourceGrant.js";
import {
  createTargetSecretSourceGrantMetadata,
  createTargetSecretSourceGrantRecordBytes,
  createTargetSecretSourceRedemptionMetadata,
  createTargetSecretSourceRedemptionRecordBytes,
  createTargetSecretSourceRevocationRecordBytes
} from "./targetSecretSourceGrantRecords.js";
import {
  deriveTargetSecretSourceOwnerEntropy,
  type TargetSecretSourceOwnerEntropyDomain
} from "./targetSecretSourceOwnerEntropy.js";
import { TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceResolver } from "./targetSecretSourceResolver.js";
import { initializeTargetSecretSourceRevoke } from "./targetSecretSourceRevoke.js";

const originalHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];
const fixed = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const handle = (value: number) =>
  parseTargetSecretSourceOpaqueHandle(`opaque_${value.toString(16).padStart(2, "0").repeat(16)}`);
const derived = (domain: TargetSecretSourceOwnerEntropyDomain, metadata: unknown) =>
  (): Uint8Array => deriveTargetSecretSourceOwnerEntropy(domain, metadata);

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

type LifecycleKind = "grant" | "redemption" | "revocation";
type Seeded = Readonly<{
  authorization: ReturnType<typeof createTargetSecretSourceAuthorization>;
  bytes: Uint8Array;
  file: string;
  invoke(): Promise<void>;
}>;

const setupHome = async (): Promise<void> => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-owner-recovery-"));
  cleanup.push(home);
  await chmod(home, 0o700);
  process.env.SPAWNFILE_HOME = home;
};

const seedLifecycle = async (kind: LifecycleKind): Promise<Seeded> => {
  await setupHome();
  const author = await initializeTargetSecretSourceAuthor({
    aliasEntropy: fixed(3),
    aliasPublicationEntropy: fixed(4),
    versionEntropy: fixed(1),
    versionPublicationEntropy: fixed(2)
  });
  const authored = await author.authorVersion(new Uint8Array([9, 8, 7]));
  const reader = await initializeTargetSecretSourceFsRead();
  const alias = await reader.readAlias(authored.source_handle);
  if (!alias) throw new Error("test fixture alias missing");
  const input: TargetSecretSourceGrantInput = {
    descriptor_digest: `sha256:${"a".repeat(64)}`,
    name: "api-token",
    run_id: "run-1",
    scope: "world",
    selected_target: {
      fingerprint: `sha256:${"b".repeat(32)}`,
      handle: handle(9),
      version: "spawnfile.target-resource.selected-target.v1"
    },
    source_handle: alias.source_handle
  };
  const grantMetadata = createTargetSecretSourceGrantMetadata({
    ...input,
    source_version_handle: alias.source_version_handle
  });
  const { version: _version, ...grantInput } = grantMetadata;
  const grant = createTargetSecretSourceGrantRecordBytes(grantInput, {
    publicationEntropy: derived("grant.publication_handle", grantMetadata)
  });
  const authorization = createTargetSecretSourceAuthorization({
    descriptorDigest: grantMetadata.descriptor_digest,
    name: grantMetadata.name,
    operationHandle: handle(10),
    requestDigest: `sha256:${"c".repeat(64)}`,
    runId: grantMetadata.run_id,
    scope: grantMetadata.scope,
    selectedTarget: {
      fingerprint: grantMetadata.selected_target.fingerprint,
      handle: grantMetadata.selected_target.handle
    },
    sourceHandle: grantMetadata.source_handle
  });

  if (kind === "grant") {
    return {
      authorization,
      bytes: grant.private_bytes,
      file: resolveTargetSecretGrantPath(alias.source_handle),
      invoke: async () => {
        await (await initializeTargetSecretSourceGrant()).grantSource(input);
      }
    };
  }

  await (await initializeTargetSecretSourceGrant()).grantSource(input);
  if (kind === "redemption") {
    const metadata = createTargetSecretSourceRedemptionMetadata(grantMetadata, authorization);
    const redemption = createTargetSecretSourceRedemptionRecordBytes(grantMetadata, authorization, {
      publicationEntropy: derived("redemption.publication_handle", metadata)
    });
    return {
      authorization,
      bytes: redemption.private_bytes,
      file: resolveTargetSecretRedemptionPath(alias.source_handle),
      invoke: async () => {
        const resolution = await (await initializeTargetSecretSourceResolver()).resolve({ authorization });
        resolution.value.fill(0);
      }
    };
  }

  const semantics = { kind: "grant" as const, revoked_handle: alias.source_handle };
  const revocation = createTargetSecretSourceRevocationRecordBytes(semantics, {
    entropy: derived("revocation.revocation_handle", semantics),
    publicationEntropy: derived("revocation.publication_handle", semantics)
  });
  return {
    authorization,
    bytes: revocation.private_bytes,
    file: resolveTargetSecretRevocationPath(alias.source_handle),
    invoke: async () => {
      await (await initializeTargetSecretSourceRevoke()).revokeGrant(alias.source_handle);
    }
  };
};

describe("target secret source owner partial-final recovery", () => {
  it.each([
    ["grant", "zero"],
    ["grant", "prefix"],
    ["redemption", "zero"],
    ["redemption", "prefix"],
    ["revocation", "zero"],
    ["revocation", "prefix"]
  ] as const)("reconstructs and recovers a real %s %s-byte final after restart", async (kind, mode) => {
    const seeded = await seedLifecycle(kind);
    const length = mode === "zero" ? 0 : seeded.bytes.length - 1;
    await writeFile(seeded.file, seeded.bytes.subarray(0, length), { mode: 0o600 });
    await seeded.invoke();
    expect(await readFile(seeded.file)).toEqual(Buffer.from(seeded.bytes));
    seeded.bytes.fill(0);
  });

  it.each(["grant", "redemption", "revocation"] as const)(
    "fails closed without replacing a conflicting real %s final",
    async (kind) => {
      const seeded = await seedLifecycle(kind);
      const conflict = Uint8Array.from(seeded.bytes);
      conflict[0] = conflict[0] === 0x7b ? 0x5b : 0x7b;
      await writeFile(seeded.file, conflict, { mode: 0o600 });
      await expect(seeded.invoke()).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      expect(await readFile(seeded.file)).toEqual(Buffer.from(conflict));
      conflict.fill(0);
      seeded.bytes.fill(0);
    }
  );

  it("domain-separates stable canonical public semantics without secret input", () => {
    const semanticA = { kind: "grant", revoked_handle: handle(3) };
    const semanticB = { revoked_handle: handle(3), kind: "grant" };
    const revocation = deriveTargetSecretSourceOwnerEntropy("revocation.revocation_handle", semanticA);
    const reordered = deriveTargetSecretSourceOwnerEntropy("revocation.revocation_handle", semanticB);
    const publication = deriveTargetSecretSourceOwnerEntropy("revocation.publication_handle", semanticA);
    expect(revocation).toEqual(reordered);
    expect(revocation).toHaveLength(16);
    expect(publication).toHaveLength(16);
    expect(publication).not.toEqual(revocation);
    revocation.fill(0);
    reordered.fill(0);
    publication.fill(0);
  });
});
