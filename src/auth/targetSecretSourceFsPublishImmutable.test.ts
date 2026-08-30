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

  it("reobserves a token torn down before its creator fstats it", async () => {
    let cut = false;
    const publisher = await setup({ hookForTest: async (phase, file) => {
      if (phase !== "after_token_open" || cut) return;
      cut = true;
      await unlink(file);
    } });
    const { input } = packet();
    await publisher.publishImmutable(input);
    expect(cut).toBe(true);
    expect((await lstat(input.final_path)).nlink).toBe(1);
  });

  it("reobserves a final disappearing between lstat and open", async () => {
    const publisher = await setup();
    const { input } = packet();
    await publisher.publishImmutable(input);
    let cut = false;
    const recovering = await initializeCurrent({ hookForTest: async (phase, file) => {
      if (phase !== "after_final_lstat" || cut) return;
      cut = true;
      await unlink(file);
    } });
    await recovering.publishImmutable(input);
    expect(cut).toBe(true);
    expect(await readFile(input.final_path)).toEqual(Buffer.from(input.bytes));
  });

  it("succeeds when peer cleanup wins the exact claim unlink", async () => {
    let cut = false;
    const publisher = await setup({ hookForTest: async (phase, file) => {
      if (phase !== "before_unlink_exact" || !file.endsWith(".claim") || cut) return;
      cut = true;
      await unlink(file);
    } });
    const { input } = packet();
    await publisher.publishImmutable(input);
    expect(cut).toBe(true);
    await expect(lstat(`${input.final_path}.claim`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("joins peer progress between final creation and the creator's first fstat", async () => {
    await setup();
    const { input } = packet(2_048);
    const helper = await initializeCurrent();
    let helped = false;
    const creator = await initializeCurrent({ hookForTest: async (phase) => {
      if (phase !== "after_final_open" || helped) return;
      helped = true;
      await helper.publishImmutable(input);
    } });
    await creator.publishImmutable(input);
    expect(helped).toBe(true);
    expect(await readFile(input.final_path)).toEqual(Buffer.from(input.bytes));
  });

  it("reobserves token teardown after its creator syncs", async () => {
    let cut = false;
    const publisher = await setup({ hookForTest: async (phase, file) => {
      if (phase !== "after_token_sync" || cut) return;
      cut = true;
      await unlink(file);
    } });
    const { input } = packet();
    await publisher.publishImmutable(input);
    expect(cut).toBe(true);
    expect(await readFile(input.final_path)).toEqual(Buffer.from(input.bytes));
  });

  it("rejects an oversized peer write after final creation", async () => {
    let cut = false;
    const publisher = await setup({ hookForTest: async (phase, file) => {
      if (phase !== "after_final_open" || cut) return;
      cut = true;
      await writeFile(file, new Uint8Array(32_768).fill(9));
    } });
    const { input } = packet();
    await expect(publisher.publishImmutable(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(cut).toBe(true);
  });

  it("reobserves a disappearing election node and fails closed when its orphan cannot commit", async () => {
    let cut = false;
    const publisher = await setup({ hookForTest: async (phase, file) => {
      if (phase !== "after_zero_lstat" || cut || !file.includes(".token.")) return;
      cut = true;
      await unlink(file);
    } });
    const { input } = packet();
    await expect(publisher.publishImmutable(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(cut).toBe(true);
  });

  it("accepts a peer-won orphan-claim cleanup after exact commit", async () => {
    const base = await setup();
    const { input } = packet();
    await base.publishImmutable(input);
    const claim = `${input.final_path}.claim`;
    await writeFile(claim, new Uint8Array(), { mode: 0o600 });
    let cut = false;
    const recovering = await initializeCurrent({ hookForTest: async (phase, file) => {
      if (phase !== "before_unlink_exact" || file !== claim || cut) return;
      cut = true;
      await unlink(file);
    } });
    await recovering.publishImmutable(input);
    expect(cut).toBe(true);
  });

  it("cleans a valid replacement orphan claim after the exact commit marker", async () => {
    const base = await setup();
    const { input } = packet();
    await base.publishImmutable(input);
    const claim = `${input.final_path}.claim`;
    await writeFile(claim, new Uint8Array(), { mode: 0o600 });
    let cut = false;
    const recovering = await initializeCurrent({ hookForTest: async (phase, file) => {
      if (phase !== "before_unlink_exact" || file !== claim || cut) return;
      cut = true;
      await unlink(file);
      await writeFile(file, new Uint8Array(), { mode: 0o600 });
    } });
    await recovering.publishImmutable(input);
    expect(cut).toBe(true);
    await expect(lstat(claim)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails re-proof when peer-won orphan cleanup coincides with final corruption", async () => {
    const base = await setup();
    const { input } = packet();
    await base.publishImmutable(input);
    const claim = `${input.final_path}.claim`;
    await writeFile(claim, new Uint8Array(), { mode: 0o600 });
    let cut = false;
    const recovering = await initializeCurrent({ hookForTest: async (phase, file) => {
      if (phase !== "before_unlink_exact" || file !== claim || cut) return;
      cut = true;
      await unlink(file);
      await writeFile(input.final_path, input.bytes.subarray(0, input.bytes.length - 1));
    } });
    await expect(recovering.publishImmutable(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(cut).toBe(true);
  });

  it("fails re-proof when peer cleanup removes the remaining claim as the final changes", async () => {
    let cut = false;
    const publisher = await setup({ hookForTest: async (phase, file) => {
      if (phase !== "after_token_cleanup" || cut) return;
      cut = true;
      await unlink(`${file.slice(0, file.indexOf(".token."))}.claim`);
      const { input } = current!;
      await writeFile(input.final_path, input.bytes.subarray(0, input.bytes.length - 1));
    } });
    const current = packet();
    await expect(publisher.publishImmutable(current.input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(cut).toBe(true);
  });

  it("reobserves an nlink-two remaining claim before peer teardown completes", async () => {
    let extra = "";
    let teardown: Promise<void> | undefined;
    const publisher = await setup({ hookForTest: async (phase, file) => {
      if (phase !== "after_token_cleanup" || teardown) return;
      const claim = `${file.slice(0, file.indexOf(".token."))}.claim`;
      extra = `${claim}.peer`;
      await link(claim, extra);
      teardown = new Promise((resolve, reject) => setTimeout(() => unlink(extra).then(resolve, reject), 0));
    } });
    const { input } = packet();
    await publisher.publishImmutable(input);
    await teardown;
    await expect(lstat(extra)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for a stable foreign claim before exact commit", async () => {
    await setup();
    const { input } = packet();
    await writeFile(`${input.final_path}.claim`, new Uint8Array(), { mode: 0o600 });
    const publisher = await initializeCurrent();
    await expect(publisher.publishImmutable(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await expect(lstat(input.final_path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the final inode is replaced between named and opened observations", async () => {
    const base = await setup();
    const { input } = packet();
    await base.publishImmutable(input);
    let replaced = false;
    const reader = await initializeCurrent({ hookForTest: async (phase, file) => {
      if (phase !== "after_final_lstat" || replaced) return;
      replaced = true;
      await unlink(file);
      await writeFile(file, input.bytes, { mode: 0o600 });
    } });
    await expect(reader.publishImmutable(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(replaced).toBe(true);
  });
});
