import { chmod, link, lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAuthHome, resolveSpawnfileHome, resolveTargetSecretVersionPath, resolveTargetSecretVersionsDirectory, resolveTargetSecretsRoot } from "./paths.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import { initializeTargetSecretSourceFsPublishImmutable } from "./targetSecretSourceFsPublishImmutable.js";
import { createTargetSecretSourceVersionRecordBytes, parseTargetSecretSourceVersionRecordBytes } from "./targetSecretSourceVersionRecords.js";

const originalHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];
const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { force: true, recursive: true })));
});

const setup = async (options: Parameters<typeof initializeTargetSecretSourceFsPublishImmutable>[0] extends infer O ? Partial<O> : never = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-secret-immutable-"));
  cleanup.push(home);
  await chmod(home, 0o700);
  process.env.SPAWNFILE_HOME = home;
  await initializeTargetSecretSourceFsRead();
  const chain = [resolveSpawnfileHome(), resolveAuthHome(), resolveTargetSecretsRoot(), resolveTargetSecretVersionsDirectory()];
  return initializeTargetSecretSourceFsPublishImmutable({ directory_chain: chain, ...options });
};
const initializeCurrent = (options: Omit<Parameters<typeof initializeTargetSecretSourceFsPublishImmutable>[0], "directory_chain"> = {}) =>
  initializeTargetSecretSourceFsPublishImmutable({
    directory_chain: [resolveSpawnfileHome(), resolveAuthHome(), resolveTargetSecretsRoot(), resolveTargetSecretVersionsDirectory()],
    ...options
  });

const packet = (secretSize = 64) => {
  const version = createTargetSecretSourceVersionRecordBytes(new Uint8Array(secretSize).fill(7), {
    entropy: entropy(1), publicationEntropy: entropy(2)
  });
  return {
    input: {
      bytes: version.private_bytes,
      final_path: resolveTargetSecretVersionPath(version.metadata.source_version_handle),
      publication_handle: version.private_metadata.publication_handle,
      proveExact: (bytes: Uint8Array) => {
        const parsed = parseTargetSecretSourceVersionRecordBytes(bytes, version.metadata.source_version_handle);
        try { expect(parsed.publication_handle).toBe(version.private_metadata.publication_handle); }
        finally { parsed.secret.fill(0); }
      }
    },
    version
  };
};

describe("targetSecretSourceFsPublishImmutable", () => {
  it("publishes one canonical final, replays exact bytes, and clears zero-byte election links", async () => {
    const publisher = await setup();
    const { input, version } = packet();
    await publisher.publishImmutable(input);
    await publisher.publishImmutable(input);
    expect(await readFile(input.final_path)).toEqual(Buffer.from(version.private_bytes));
    expect((await lstat(input.final_path)).nlink).toBe(1);
    await expect(lstat(`${input.final_path}.claim`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${input.final_path}.token.${input.publication_handle}`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("joins identical writers and honors actual short writes", async () => {
    await setup();
    const { input, version } = packet(2_048);
    const publishers = await Promise.all(Array.from({ length: 12 }, () => initializeCurrent({ maxWriteBytesForTest: 3 })));
    await Promise.all(publishers.map((publisher) => publisher.publishImmutable(input)));
    expect(await readFile(input.final_path)).toEqual(Buffer.from(version.private_bytes));
  });

  it("keeps token and claim zero-byte through durable crash hooks and recovers", async () => {
    for (const phase of [
      "after_token_create", "after_claim_link", "after_final_create", "after_partial_write",
      "after_file_sync", "after_directory_sync", "after_token_cleanup", "after_claim_cleanup"
    ] as const) {
      const crashing = await setup({ hookForTest: async (seen, file) => {
        if (seen !== phase) return;
        if (seen === "after_claim_link") expect((await lstat(file)).size).toBe(0);
        throw new Error("crash");
      } });
      const { input } = packet();
      await expect(crashing.publishImmutable(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      const recovering = await initializeCurrent();
      await expect(recovering.publishImmutable(input)).resolves.toBeUndefined();
    }
  });

  it("rejects path escape and a publication-handle mismatch before mutation", async () => {
    const publisher = await setup();
    const { input } = packet();
    await expect(publisher.publishImmutable({ ...input, final_path: path.join(path.dirname(input.final_path), "..", "escape") }))
      .rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await expect(publisher.publishImmutable({ ...input, publication_handle: "invalid" }))
      .rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("proves owned bytes before mutation and re-proves the exact completed final", async () => {
    const publisher = await setup();
    const { input } = packet();
    let calls = 0;
    await expect(publisher.publishImmutable({
      ...input,
      proveExact: () => { calls += 1; throw new Error("reject"); }
    })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(calls).toBe(1);
    await expect(lstat(input.final_path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${input.final_path}.claim`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${input.final_path}.token.${input.publication_handle}`)).rejects.toMatchObject({ code: "ENOENT" });
    calls = 0;
    await publisher.publishImmutable({ ...input, proveExact: () => { calls += 1; } });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("reobserves disappearing mismatched nodes and a replacement cleanup generation", async () => {
    await setup();
    const first = packet();
    const firstClaim = `${first.input.final_path}.claim`;
    const firstToken = `${first.input.final_path}.token.${first.input.publication_handle}`;
    await writeFile(firstClaim, new Uint8Array(), { mode: 0o600 });
    await writeFile(firstToken, new Uint8Array(), { mode: 0o600 });
    let mismatched = false;
    const mismatchPublisher = await initializeCurrent({ hookForTest: async (phase) => {
      if (phase !== "after_mismatch_snapshot" || mismatched) return;
      mismatched = true;
      await unlink(firstToken);
      await unlink(firstClaim);
    } });
    await mismatchPublisher.publishImmutable(first.input);
    expect(mismatched).toBe(true);

    const secondVersion = createTargetSecretSourceVersionRecordBytes(new Uint8Array(64).fill(8), {
      entropy: entropy(3), publicationEntropy: entropy(4)
    });
    const secondInput = {
      bytes: secondVersion.private_bytes,
      final_path: resolveTargetSecretVersionPath(secondVersion.metadata.source_version_handle),
      publication_handle: secondVersion.private_metadata.publication_handle,
      proveExact: (bytes: Uint8Array) => {
        const parsed = parseTargetSecretSourceVersionRecordBytes(bytes, secondVersion.metadata.source_version_handle);
        parsed.secret.fill(0);
      }
    };
    const secondClaim = `${secondInput.final_path}.claim`;
    const secondToken = `${secondInput.final_path}.token.${secondInput.publication_handle}`;
    let replaced = false;
    const replacementPublisher = await initializeCurrent({ hookForTest: async (phase) => {
      if (phase !== "after_exact_token_snapshot" || replaced) return;
      replaced = true;
      await unlink(secondToken);
      await unlink(secondClaim);
      await writeFile(secondToken, new Uint8Array(), { mode: 0o600 });
      await link(secondToken, secondClaim);
    } });
    await replacementPublisher.publishImmutable(secondInput);
    expect(replaced).toBe(true);
    await expect(lstat(secondToken)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(secondClaim)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
