import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as grantRecordParsers from "./targetSecretSourceGrantRecords.js";
import * as versionRecordParsers from "./targetSecretSourceVersionRecords.js";

import {
  resolveTargetSecretAliasPath,
  resolveTargetSecretGrantPath,
  resolveTargetSecretRedemptionPath,
  resolveTargetSecretRevocationPath
} from "./paths.js";
import {
  createTargetSecretSourceGrantRecordBytes,
  createTargetSecretSourceRedemptionRecordBytes,
  createTargetSecretSourceRevocationRecordBytes
} from "./targetSecretSourceGrantRecords.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceRecordPublish } from "./targetSecretSourceRecordPublish.js";
import { createTargetSecretSourceAliasRecordBytes, createTargetSecretSourceVersionRecordBytes } from "./targetSecretSourceVersionRecords.js";

const originalHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];
const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const handle = (value: string): string => `opaque_${value.padEnd(16, "0")}`;
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME; else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});
const setup = async (options: Parameters<typeof initializeTargetSecretSourceRecordPublish>[0] = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-public-records-"));
  cleanup.push(home); await chmod(home, 0o700); process.env.SPAWNFILE_HOME = home;
  return initializeTargetSecretSourceRecordPublish(options);
};
const records = () => {
  const version = createTargetSecretSourceVersionRecordBytes(new Uint8Array([1]), { entropy: entropy(1), publicationEntropy: entropy(2) });
  const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, { entropy: entropy(3), publicationEntropy: entropy(4) });
  const grant = createTargetSecretSourceGrantRecordBytes({
    descriptor_digest: digest("a"), name: "token", run_id: "run-1", scope: "world",
    selected_target: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("target"), version: "spawnfile.target-resource.selected-target.v1" },
    source_handle: alias.metadata.source_handle, source_version_handle: version.metadata.source_version_handle
  }, { publicationEntropy: entropy(5) });
  const authorization = {
    descriptorDigest: digest("a"), name: "token", operationHandle: handle("operation"), requestDigest: digest("c"),
    runId: "run-1", scope: "world", selectedTarget: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("target") },
    sourceHandle: alias.metadata.source_handle, version: "spawnfile.target-secret-source.authorization.v1"
  };
  const redemption = createTargetSecretSourceRedemptionRecordBytes(grant.metadata, authorization as never, { publicationEntropy: entropy(6) });
  const revocation = createTargetSecretSourceRevocationRecordBytes(
    { kind: "grant", revoked_handle: alias.metadata.source_handle },
    { entropy: entropy(7), publicationEntropy: entropy(8) }
  );
  return { alias, grant, redemption, revocation };
};

describe("targetSecretSourceRecordPublish", () => {
  it("rejects non-byte inputs for every immutable record kind", async () => {
    const publisher = await setup();
    for (const publish of [publisher.publishAlias, publisher.publishGrant, publisher.publishRedemption, publisher.publishRevocation]) {
      await expect(publish("not-bytes" as never)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    }
  });

  it("rejects different bytes colliding on every immutable record handle", async () => {
    const publisher = await setup();
    const value = records();
    await publisher.publishAlias(value.alias.private_bytes);
    await publisher.publishGrant(value.grant.private_bytes);
    await publisher.publishRedemption(value.redemption.private_bytes);
    await publisher.publishRevocation(value.revocation.private_bytes);

    const otherVersion = createTargetSecretSourceVersionRecordBytes(new Uint8Array([9]), {
      entropy: entropy(9), publicationEntropy: entropy(10)
    });
    const aliasCollision = createTargetSecretSourceAliasRecordBytes(otherVersion.metadata, {
      entropy: entropy(3), publicationEntropy: entropy(4)
    });
    const grantCollision = createTargetSecretSourceGrantRecordBytes({
      descriptor_digest: digest("a"), name: "other", run_id: "run-1", scope: "world",
      selected_target: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("target"), version: "spawnfile.target-resource.selected-target.v1" },
      source_handle: value.alias.metadata.source_handle, source_version_handle: value.grant.metadata.source_version_handle
    }, { publicationEntropy: entropy(5) });
    const authorization = {
      descriptorDigest: digest("a"), name: "token", operationHandle: handle("operation"), requestDigest: digest("d"),
      runId: "run-1", scope: "world", selectedTarget: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("target") },
      sourceHandle: value.alias.metadata.source_handle, version: "spawnfile.target-secret-source.authorization.v1"
    };
    const redemptionCollision = createTargetSecretSourceRedemptionRecordBytes(value.grant.metadata, authorization as never, {
      publicationEntropy: entropy(6)
    });
    const revocationCollision = createTargetSecretSourceRevocationRecordBytes(
      { kind: "version", revoked_handle: value.alias.metadata.source_handle },
      { entropy: entropy(7), publicationEntropy: entropy(8) }
    );
    for (const publish of [
      () => publisher.publishAlias(aliasCollision.private_bytes),
      () => publisher.publishGrant(grantCollision.private_bytes),
      () => publisher.publishRedemption(redemptionCollision.private_bytes),
      () => publisher.publishRevocation(revocationCollision.private_bytes)
    ]) await expect(publish()).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("revalidates embedded handles for every record kind during immutable proof", async () => {
    const publisher = await setup();
    const value = records();
    const cases = [
      [versionRecordParsers, "parseTargetSecretSourceAliasRecordBytesForPublication", value.alias.private_bytes, publisher.publishAlias],
      [grantRecordParsers, "parseTargetSecretSourceGrantRecordBytesForPublication", value.grant.private_bytes, publisher.publishGrant],
      [grantRecordParsers, "parseTargetSecretSourceRedemptionRecordBytesForPublication", value.redemption.private_bytes, publisher.publishRedemption],
      [grantRecordParsers, "parseTargetSecretSourceRevocationRecordBytesForPublication", value.revocation.private_bytes, publisher.publishRevocation]
    ] as const;
    for (const [module, name, bytes, publish] of cases) {
      const parserModule = module as unknown as Record<string, (raw: Uint8Array) => Record<string, unknown>>;
      const original = parserModule[name]!;
      let calls = 0;
      const spy = vi.spyOn(parserModule, name).mockImplementation((raw: Uint8Array) => {
        const parsed = original(raw);
        calls += 1;
        return calls === 1 ? parsed : { ...parsed, publication_handle: handle("embedded-mismatch") };
      });
      await expect(publish(bytes)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      expect(calls).toBeGreaterThanOrEqual(2);
      spy.mockRestore();
    }
  });

  it("publishes and exactly replays all four parser-proven direct leaves", async () => {
    const publisher = await setup(); const value = records();
    const cases = [
      [value.alias.private_bytes, () => publisher.publishAlias(value.alias.private_bytes), resolveTargetSecretAliasPath(value.alias.metadata.source_handle)],
      [value.grant.private_bytes, () => publisher.publishGrant(value.grant.private_bytes), resolveTargetSecretGrantPath(value.grant.metadata.source_handle)],
      [value.redemption.private_bytes, () => publisher.publishRedemption(value.redemption.private_bytes), resolveTargetSecretRedemptionPath(value.redemption.metadata.source_handle)],
      [value.revocation.private_bytes, () => publisher.publishRevocation(value.revocation.private_bytes), resolveTargetSecretRevocationPath(value.revocation.metadata.revoked_handle)]
    ] as const;
    for (const [bytes, publish, file] of cases) {
      await publish(); await publish();
      expect(await readFile(file)).toEqual(Buffer.from(bytes));
      expect((await lstat(file)).nlink).toBe(1);
    }
  });

  it("joins twelve same-key writers through the shared primitive", async () => {
    await setup(); const value = records();
    const writers = await Promise.all(Array.from({ length: 12 }, () => initializeTargetSecretSourceRecordPublish()));
    await Promise.all(writers.map((writer) => writer.publishAlias(value.alias.private_bytes)));
    expect(await readFile(resolveTargetSecretAliasPath(value.alias.metadata.source_handle))).toEqual(Buffer.from(value.alias.private_bytes));
  });

  it("recovers every durable crash phase for every kind and keeps election files zero-byte", async () => {
    const phases = ["after_token_create", "after_claim_link", "after_final_create", "after_partial_write", "after_file_sync", "after_directory_sync", "after_token_cleanup", "after_claim_cleanup"] as const;
    for (const phase of phases) {
      const crashing = await setup({ hookForTest: async (seen, file) => {
        if (seen !== phase) return;
        if (seen === "after_claim_link") expect((await lstat(file)).size).toBe(0);
        throw new Error("crash");
      } });
      const value = records();
      for (const [publish, recover] of [
        [() => crashing.publishAlias(value.alias.private_bytes), (p: Awaited<ReturnType<typeof initializeTargetSecretSourceRecordPublish>>) => p.publishAlias(value.alias.private_bytes)],
        [() => crashing.publishGrant(value.grant.private_bytes), (p: Awaited<ReturnType<typeof initializeTargetSecretSourceRecordPublish>>) => p.publishGrant(value.grant.private_bytes)],
        [() => crashing.publishRedemption(value.redemption.private_bytes), (p: Awaited<ReturnType<typeof initializeTargetSecretSourceRecordPublish>>) => p.publishRedemption(value.redemption.private_bytes)],
        [() => crashing.publishRevocation(value.revocation.private_bytes), (p: Awaited<ReturnType<typeof initializeTargetSecretSourceRecordPublish>>) => p.publishRevocation(value.revocation.private_bytes)]
      ] as const) {
        await expect(publish()).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
        await recover(await initializeTargetSecretSourceRecordPublish());
      }
    }
  }, 30_000);

  it("rejects wrong-kind and noncanonical bytes before publication", async () => {
    const publisher = await setup(); const value = records();
    await expect(publisher.publishGrant(value.alias.private_bytes)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await expect(publisher.publishAlias(new Uint8Array([...value.alias.private_bytes, 32]))).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("routes every kind through prefix recovery, actual short writes, and repeated 16/32-way joins", async () => {
    await setup(); const value = records();
    const makeCases = (publisher: Awaited<ReturnType<typeof initializeTargetSecretSourceRecordPublish>>) => [
      { bytes: value.alias.private_bytes, file: resolveTargetSecretAliasPath(value.alias.metadata.source_handle), publish: () => publisher.publishAlias(value.alias.private_bytes) },
      { bytes: value.grant.private_bytes, file: resolveTargetSecretGrantPath(value.grant.metadata.source_handle), publish: () => publisher.publishGrant(value.grant.private_bytes) },
      { bytes: value.redemption.private_bytes, file: resolveTargetSecretRedemptionPath(value.redemption.metadata.source_handle), publish: () => publisher.publishRedemption(value.redemption.private_bytes) },
      { bytes: value.revocation.private_bytes, file: resolveTargetSecretRevocationPath(value.revocation.metadata.revoked_handle), publish: () => publisher.publishRevocation(value.revocation.private_bytes) }
    ] as const;
    const prefixWriter = await initializeTargetSecretSourceRecordPublish();
    await Promise.all(makeCases(prefixWriter).map(async (item) => {
      for (let length = 0; length < item.bytes.length; length += 1) {
        await writeFile(item.file, item.bytes.subarray(0, length), { mode: 0o600 });
        await item.publish();
        expect(await readFile(item.file)).toEqual(Buffer.from(item.bytes));
        await rm(item.file);
      }
    }));
    const shortWriter = await initializeTargetSecretSourceRecordPublish({ maxWriteBytesForTest: 1 });
    await Promise.all(makeCases(shortWriter).map((item) => item.publish()));
    for (const item of makeCases(shortWriter)) {
      expect(await readFile(item.file)).toEqual(Buffer.from(item.bytes));
    }
    for (let round = 0; round < 3; round += 1) {
      const writerCount = round % 2 === 0 ? 16 : 32;
      const writers = await Promise.all(Array.from({ length: writerCount }, () => initializeTargetSecretSourceRecordPublish()));
      for (let index = 0; index < 4; index += 1) {
        await rm(makeCases(writers[0]!)[index]!.file, { force: true });
        await Promise.all(writers.map((writer) => makeCases(writer)[index]!.publish()));
      }
    }
  }, 120_000);

  it("fails closed for hostile file modes and parent replacement for every kind", async () => {
    const value = records();
    for (const kind of ["alias", "grant", "redemption", "revocation"] as const) {
      const base = await setup();
      const bytes = kind === "alias" ? value.alias.private_bytes
        : kind === "grant" ? value.grant.private_bytes
        : kind === "redemption" ? value.redemption.private_bytes
        : value.revocation.private_bytes;
      const file = kind === "alias" ? resolveTargetSecretAliasPath(value.alias.metadata.source_handle)
        : kind === "grant" ? resolveTargetSecretGrantPath(value.grant.metadata.source_handle)
        : kind === "redemption" ? resolveTargetSecretRedemptionPath(value.redemption.metadata.source_handle)
        : resolveTargetSecretRevocationPath(value.revocation.metadata.revoked_handle);
      const publishBase = kind === "alias" ? () => base.publishAlias(value.alias.private_bytes)
        : kind === "grant" ? () => base.publishGrant(value.grant.private_bytes)
        : kind === "redemption" ? () => base.publishRedemption(value.redemption.private_bytes)
        : () => base.publishRevocation(value.revocation.private_bytes);
      await writeFile(file, bytes, { mode: 0o644 });
      await expect(publishBase()).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      await rm(file);
      const foreign = `${file}.foreign`;
      await writeFile(foreign, bytes, { mode: 0o600 });
      await symlink(foreign, file);
      await expect(publishBase()).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      await rm(file);
      await link(foreign, file);
      await expect(publishBase()).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      await rm(file); await rm(foreign);
      let replaced = false;
      const publisher = await setup({ hookForTest: async (phase, file) => {
        if (phase !== "before_directory_sync" || replaced) return;
        replaced = true;
        const directory = path.dirname(file);
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory, { mode: 0o700 });
      } });
      const publish = kind === "alias" ? () => publisher.publishAlias(value.alias.private_bytes)
        : kind === "grant" ? () => publisher.publishGrant(value.grant.private_bytes)
        : kind === "redemption" ? () => publisher.publishRedemption(value.redemption.private_bytes)
        : () => publisher.publishRevocation(value.revocation.private_bytes);
      await expect(publish()).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      expect(replaced).toBe(true);
    }
  });
});
