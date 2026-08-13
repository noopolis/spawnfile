import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTargetSecretSourceGrantRecordBytes, createTargetSecretSourceRedemptionRecordBytes, createTargetSecretSourceRevocationRecordBytes } from "./targetSecretSourceGrantRecords.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import { resolveTargetSecretAliasPath, resolveTargetSecretAliasesDirectory, resolveTargetSecretGrantPath, resolveTargetSecretGrantsDirectory, resolveTargetSecretRedemptionPath, resolveTargetSecretRedemptionsDirectory, resolveTargetSecretRevocationPath, resolveTargetSecretRevocationsDirectory, resolveTargetSecretVersionPath, resolveTargetSecretVersionsDirectory, resolveTargetSecretsRoot } from "./paths.js";
import { createTargetSecretSourceAliasRecordBytes, createTargetSecretSourceVersionRecordBytes } from "./targetSecretSourceVersionRecords.js";

const originalHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];
const handle = (value: string): string => `opaque_${value.padEnd(16, "0")}`;
const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME; else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const setup = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-secret-read-"));
  cleanup.push(home); await chmod(home, 0o700); process.env.SPAWNFILE_HOME = home;
  return initializeTargetSecretSourceFsRead();
};
const authorization = (sourceHandle: string) => ({ descriptorDigest: digest("a"), name: "token", operationHandle: handle("operation"),
  requestDigest: digest("c"), runId: "run-1", scope: "world", selectedTarget: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("target") }, sourceHandle,
  version: "spawnfile.target-secret-source.authorization.v1" });

const seed = async () => {
  const reader = await setup();
  const version = createTargetSecretSourceVersionRecordBytes(new Uint8Array([1, 2, 3]), { entropy: entropy(1) });
  const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, { entropy: entropy(2) });
  const grant = createTargetSecretSourceGrantRecordBytes({ descriptor_digest: digest("a"), name: "token", run_id: "run-1", scope: "world",
    selected_target: { fingerprint: `sha256:${"b".repeat(32)}`, handle: handle("target"), version: "spawnfile.target-resource.selected-target.v1" },
    source_handle: alias.metadata.source_handle, source_version_handle: version.metadata.source_version_handle });
  const redemption = createTargetSecretSourceRedemptionRecordBytes(grant.metadata, authorization(alias.metadata.source_handle) as never);
  const revocation = createTargetSecretSourceRevocationRecordBytes({ kind: "grant", revoked_handle: alias.metadata.source_handle }, { entropy: entropy(3) });
  await Promise.all([
    writeFile(resolveTargetSecretVersionPath(version.metadata.source_version_handle), version.private_bytes, { mode: 0o600 }),
    writeFile(resolveTargetSecretAliasPath(alias.metadata.source_handle), alias.private_bytes, { mode: 0o600 }),
    writeFile(resolveTargetSecretGrantPath(alias.metadata.source_handle), grant.private_bytes, { mode: 0o600 }),
    writeFile(resolveTargetSecretRedemptionPath(alias.metadata.source_handle), redemption.private_bytes, { mode: 0o600 }),
    writeFile(resolveTargetSecretRevocationPath(alias.metadata.source_handle), revocation.private_bytes, { mode: 0o600 })
  ]);
  return { alias, grant, reader, redemption, revocation, version };
};

describe("targetSecretSourceFsRead", () => {
  it("reads every fixed direct-key record and survives a fresh-process restart", async () => {
    const seeded = await seed(); const source = seeded.alias.metadata.source_handle; const version = seeded.version.metadata.source_version_handle;
    expect((await seeded.reader.readVersion(version))?.secret).toEqual(new Uint8Array([1, 2, 3]));
    expect((await seeded.reader.readAlias(source))?.source_version_handle).toBe(version);
    expect((await seeded.reader.readGrant(source))?.source_handle).toBe(source);
    expect((await seeded.reader.readRedemption(source))?.authorization.requestDigest).toBe(digest("c"));
    expect((await seeded.reader.readRevocation(source))?.revocation_handle).toBe(seeded.revocation.metadata.revocation_handle);
    expect((await (await initializeTargetSecretSourceFsRead()).readGrant(source))?.source_handle).toBe(source);
  });

  it("returns null only for an absent exact leaf", async () => {
    const reader = await setup();
    await expect(reader.readVersion(handle("missing"))).resolves.toBeNull();
    await expect(reader.readGrant("not-a-handle")).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("rejects symlink, hardlink, modes, nonregular, oversize, trailing, and corrupt leaves", async () => {
    const seeded = await seed(); const source = seeded.alias.metadata.source_handle; const grant = resolveTargetSecretGrantPath(source);
    const foreign = path.join(path.dirname(grant), "foreign"); await writeFile(foreign, seeded.grant.private_bytes, { mode: 0o600 });
    await rm(grant); await symlink(foreign, grant); await expect(seeded.reader.readGrant(source)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await rm(grant); await link(foreign, grant); await expect(seeded.reader.readGrant(source)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await rm(grant); await writeFile(grant, seeded.grant.private_bytes, { mode: 0o600 }); await chmod(grant, 0o644);
    await expect(seeded.reader.readGrant(source)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await chmod(resolveTargetSecretVersionsDirectory(), 0o1700); await expect(initializeTargetSecretSourceFsRead()).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("rejects oversized, trailing, corrupt, and replacement-shaped records without listing", async () => {
    const seeded = await seed(); const version = seeded.version.metadata.source_version_handle; const file = resolveTargetSecretVersionPath(version);
    await writeFile(file, new Uint8Array(65_537), { mode: 0o600 }); await expect(seeded.reader.readVersion(version)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await writeFile(file, new Uint8Array([...seeded.version.private_bytes, 32]), { mode: 0o600 }); await expect(seeded.reader.readVersion(version)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await writeFile(file, "{}", { mode: 0o600 }); await expect(seeded.reader.readVersion(version)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await rm(file); await mkdir(file, { mode: 0o700 }); await expect(seeded.reader.readVersion(version)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    const source = await readFile(new URL("./targetSecretSourceFsRead.ts", import.meta.url), "utf8");
    expect(source).not.toContain("readdir"); expect(source).toContain("await lstat(file, { bigint: true })"); expect(source).toContain("await handle.stat({ bigint: true })");
  });

  it("binds the parent chain on every read and rejects deterministic replacement between checks", async () => {
    const seeded = await seed(); const source = seeded.alias.metadata.source_handle;
    const replacingReader = await initializeTargetSecretSourceFsRead({ beforeOpenForTest: async (file) => {
      await rm(file); await writeFile(file, seeded.grant.private_bytes, { mode: 0o600 });
    } });
    await expect(replacingReader.readGrant(source)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    const absentRaceReader = await initializeTargetSecretSourceFsRead({ beforeLeafLstatForTest: async () => {
      await rm(resolveTargetSecretsRoot(), { force: true, recursive: true });
    } });
    await expect(absentRaceReader.readGrant(source)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    const root = resolveTargetSecretsRoot(); await rm(root, { force: true, recursive: true });
    for (const directory of [root, resolveTargetSecretVersionsDirectory(), resolveTargetSecretGrantsDirectory(), resolveTargetSecretRedemptionsDirectory(), resolveTargetSecretRevocationsDirectory(), resolveTargetSecretAliasesDirectory()]) {
      await mkdir(directory, { mode: 0o700 });
    }
    await expect(seeded.reader.readGrant(source)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });
});
