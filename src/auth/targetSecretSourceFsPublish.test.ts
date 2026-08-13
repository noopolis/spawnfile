import { chmod, link, lstat, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TARGET_SECRET_SOURCE_ERROR,
  createCanonicalTargetSecretSourceJson,
  encodeTargetSecretSourceSecret
} from "./targetSecretSourceRecordCommon.js";
import {
  initializeTargetSecretSourceFsPublish,
  type TargetSecretSourceFsPublishInput
} from "./targetSecretSourceFsPublish.js";
import {
  resolveTargetSecretVersionPath,
  resolveTargetSecretVersionsDirectory
} from "./paths.js";
import {
  TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION,
  createTargetSecretSourceVersionRecordBytes
} from "./targetSecretSourceVersionRecords.js";

const originalHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];
const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const makeInput = (source: number, publication: number, secret = new Uint8Array([1, 2, 3])) => {
  const version = createTargetSecretSourceVersionRecordBytes(secret, {
    entropy: entropy(source),
    publicationEntropy: entropy(publication)
  });
  const input: TargetSecretSourceFsPublishInput = {
    bytes: version.private_bytes,
    private_metadata: {
      publication_handle: version.private_metadata.publication_handle,
      source_version_handle: version.private_metadata.source_version_handle
    }
  };
  return { input, version };
};
const setup = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-version-publish-"));
  cleanup.push(home);
  await chmod(home, 0o700);
  process.env.SPAWNFILE_HOME = home;
  return { home, publisher: await initializeTargetSecretSourceFsPublish() };
};
const pathsFor = (input: TargetSecretSourceFsPublishInput) => {
  const final = resolveTargetSecretVersionPath(input.private_metadata.source_version_handle);
  return {
    claim: `${final}.claim`,
    final,
    token: `${final}.token.${input.private_metadata.publication_handle}`
  };
};
afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("targetSecretSourceFsPublish", () => {
  it("publishes only the canonical final and replays exact bytes", async () => {
    const { publisher } = await setup();
    const { input } = makeInput(1, 2);
    await expect(publisher.publishVersion(input)).resolves.toBeUndefined();
    await expect(publisher.publishVersion(input)).resolves.toBeUndefined();
    const paths = pathsFor(input);
    expect(await readFile(paths.final)).toEqual(Buffer.from(input.bytes));
    const stat = await lstat(paths.final);
    expect(stat.nlink).toBe(1);
    expect(stat.mode & 0o7777).toBe(0o600);
    await expect(lstat(paths.claim)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.token)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers every durable crash phase from a fresh home and handle", async () => {
    const phases = [
      "after_token_create", "after_claim_link", "after_final_create", "after_partial_write",
      "after_file_sync", "after_directory_sync", "after_token_cleanup", "after_claim_cleanup"
    ] as const;
    for (const [index, phase] of phases.entries()) {
      await setup();
      const { input } = makeInput(index + 10, index + 40);
      let hit = false;
      const crashing = await initializeTargetSecretSourceFsPublish({
        hookForTest: async (seen) => {
          if (seen === phase) { hit = true; throw new Error("crash"); }
        }
      });
      await expect(crashing.publishVersion(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
      expect(hit).toBe(true);
      const retry = await initializeTargetSecretSourceFsPublish();
      await expect(retry.publishVersion(input)).resolves.toBeUndefined();
      const paths = pathsFor(input);
      expect(await readFile(paths.final)).toEqual(Buffer.from(input.bytes));
      expect((await lstat(paths.final)).nlink).toBe(1);
      await expect(lstat(paths.claim)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(paths.token)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("joins many identical publishers and leaves one exact final", async () => {
    await setup();
    const { input } = makeInput(70, 71, new Uint8Array(2_048).fill(7));
    const publishers = await Promise.all(Array.from({ length: 12 }, () => initializeTargetSecretSourceFsPublish()));
    await expect(Promise.all(publishers.map((publisher) => publisher.publishVersion(input)))).resolves.toHaveLength(12);
    const paths = pathsFor(input);
    expect(await readFile(paths.final)).toEqual(Buffer.from(input.bytes));
    expect((await lstat(paths.final)).nlink).toBe(1);
  });

  it("reobserves a stale nlink-two claim after the token disappears", async () => {
    await setup();
    const { input } = makeInput(72, 73, new Uint8Array(512).fill(9));
    let releaseOwnerCleanup!: () => void;
    let releaseOwnerFinish!: () => void;
    let releaseLoserSnapshot!: () => void;
    let ownerDurable!: () => void;
    let tokenGone!: () => void;
    let loserSnapshotted!: () => void;
    const ownerCleanup = new Promise<void>((resolve) => { releaseOwnerCleanup = resolve; });
    const ownerFinish = new Promise<void>((resolve) => { releaseOwnerFinish = resolve; });
    const loserSnapshot = new Promise<void>((resolve) => { releaseLoserSnapshot = resolve; });
    const durable = new Promise<void>((resolve) => { ownerDurable = resolve; });
    const removed = new Promise<void>((resolve) => { tokenGone = resolve; });
    const snapshotted = new Promise<void>((resolve) => { loserSnapshotted = resolve; });
    const owner = await initializeTargetSecretSourceFsPublish({
      hookForTest: async (phase) => {
        if (phase === "after_directory_sync") { ownerDurable(); await ownerCleanup; }
        if (phase === "after_token_cleanup") { tokenGone(); await ownerFinish; }
      }
    });
    let heldLoser = false;
    const loser = await initializeTargetSecretSourceFsPublish({
      hookForTest: async (phase) => {
        if (phase === "after_claim_snapshot" && !heldLoser) {
          heldLoser = true;
          loserSnapshotted();
          await loserSnapshot;
        }
      }
    });
    const owning = owner.publishVersion(input);
    await durable;
    const joining = loser.publishVersion(input);
    await snapshotted;
    releaseOwnerCleanup();
    await removed;
    releaseLoserSnapshot();
    await expect(joining).resolves.toBeUndefined();
    releaseOwnerFinish();
    await expect(owning).resolves.toBeUndefined();
    const paths = pathsFor(input);
    expect(await readFile(paths.final)).toEqual(Buffer.from(input.bytes));
    await expect(lstat(paths.claim)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.token)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reobserves when mismatched valid nodes disappear before exact cleanup", async () => {
    await setup();
    const { input } = makeInput(76, 77, new Uint8Array(512).fill(13));
    const paths = pathsFor(input);
    await writeFile(paths.claim, new Uint8Array(), { mode: 0o600 });
    await writeFile(paths.token, new Uint8Array(), { mode: 0o600 });
    let raced = false;
    const publisher = await initializeTargetSecretSourceFsPublish({
      hookForTest: async (phase) => {
        if (phase !== "after_mismatch_snapshot" || raced) return;
        raced = true;
        await unlink(paths.token);
        await unlink(paths.claim);
      }
    });
    await expect(publisher.publishVersion(input)).resolves.toBeUndefined();
    expect(raced).toBe(true);
    expect(await readFile(paths.final)).toEqual(Buffer.from(input.bytes));
    await expect(lstat(paths.claim)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.token)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reobserves a replacement generation between final cleanup snapshots", async () => {
    await setup();
    const { input } = makeInput(78, 79, new Uint8Array(512).fill(15));
    const paths = pathsFor(input);
    let replaced = false;
    const publisher = await initializeTargetSecretSourceFsPublish({
      hookForTest: async (phase) => {
        if (phase !== "after_exact_token_snapshot" || replaced) return;
        replaced = true;
        await unlink(paths.token);
        await unlink(paths.claim);
        await writeFile(paths.token, new Uint8Array(), { mode: 0o600 });
        await link(paths.token, paths.claim);
      }
    });
    await expect(publisher.publishVersion(input)).resolves.toBeUndefined();
    expect(replaced).toBe(true);
    expect(await readFile(paths.final)).toEqual(Buffer.from(input.bytes));
    await expect(lstat(paths.claim)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.token)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors every actual short write before and after the partial boundary", async () => {
    await setup();
    const { input } = makeInput(74, 75, new Uint8Array(257).fill(11));
    let partialSize = 0;
    const publisher = await initializeTargetSecretSourceFsPublish({
      maxWriteBytesForTest: 1,
      hookForTest: async (phase, file) => {
        if (phase === "after_partial_write") partialSize = (await lstat(file)).size;
      }
    });
    await expect(publisher.publishVersion(input)).resolves.toBeUndefined();
    expect(partialSize).toBe(Math.floor(input.bytes.length / 2));
    expect(await readFile(pathsFor(input).final)).toEqual(Buffer.from(input.bytes));
  });

  it("rejects a different publication handle before mutating the final", async () => {
    await setup();
    const first = makeInput(80, 81);
    const source = first.version.metadata.source_version_handle;
    let held = false;
    const owner = await initializeTargetSecretSourceFsPublish({
      hookForTest: async (phase) => {
        if (phase === "after_claim_link") { held = true; throw new Error("crash"); }
      }
    });
    await expect(owner.publishVersion(first.input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(held).toBe(true);
    const publication = makeInput(90, 91).version.private_metadata.publication_handle;
    const bytes = createCanonicalTargetSecretSourceJson({
      publication_handle: publication,
      secret: encodeTargetSecretSourceSecret(new Uint8Array([1, 2, 3])),
      source_version_handle: source,
      version: TARGET_SECRET_SOURCE_VERSION_RECORD_VERSION
    });
    const conflicting: TargetSecretSourceFsPublishInput = {
      bytes,
      private_metadata: { publication_handle: publication, source_version_handle: source }
    };
    const rival = await initializeTargetSecretSourceFsPublish();
    await expect(rival.publishVersion(conflicting)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await expect(lstat(resolveTargetSecretVersionPath(source))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${resolveTargetSecretVersionPath(source)}.token.${publication}`))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects wrong-prefix, oversized, and malformed finals without cleanup", async () => {
    await setup();
    const { input } = makeInput(100, 101, new Uint8Array(64).fill(5));
    const crashing = await initializeTargetSecretSourceFsPublish({
      hookForTest: async (phase, file) => {
        if (phase === "after_partial_write") {
          const fd = await open(file, "r+");
          try { await fd.write(new Uint8Array([255]), 0, 1, 0); } finally { await fd.close(); }
          throw new Error("crash");
        }
      }
    });
    await expect(crashing.publishVersion(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    const retry = await initializeTargetSecretSourceFsPublish();
    await expect(retry.publishVersion(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    const paths = pathsFor(input);
    await writeFile(paths.final, new Uint8Array(input.bytes.length + 1).fill(1), { mode: 0o600 });
    await expect(retry.publishVersion(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await writeFile(paths.final, "{}", { mode: 0o600 });
    await expect(retry.publishVersion(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect((await lstat(paths.claim)).size).toBe(0);
    expect((await lstat(paths.token)).size).toBe(0);
  });

  it("keeps claims zero-byte while the secret-bearing final is paused", async () => {
    await setup();
    const sentinel = new TextEncoder().encode("PUBLISH_SENTINEL_ONLY_FINAL");
    const { input } = makeInput(110, 111, sentinel);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const publisher = await initializeTargetSecretSourceFsPublish({
      hookForTest: async (phase) => {
        if (phase === "after_partial_write") { reached(); await barrier; }
      }
    });
    const running = publisher.publishVersion(input);
    await paused;
    const paths = pathsFor(input);
    expect((await lstat(paths.claim)).size).toBe(0);
    expect((await lstat(paths.token)).size).toBe(0);
    const files = await Promise.all([readFile(paths.claim), readFile(paths.token), readFile(paths.final)]);
    expect(files[0]?.length).toBe(0);
    expect(files[1]?.length).toBe(0);
    expect(files[2]?.length).toBeGreaterThan(0);
    release();
    await expect(running).resolves.toBeUndefined();
  });

  it("fails closed on hostile claim topology and directory replacement", async () => {
    const { home } = await setup();
    const { input } = makeInput(120, 121);
    const paths = pathsFor(input);
    await writeFile(`${paths.claim}.foreign`, "", { mode: 0o600 });
    await symlink(`${paths.claim}.foreign`, paths.claim);
    const publisher = await initializeTargetSecretSourceFsPublish();
    await expect(publisher.publishVersion(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await rm(paths.claim);
    await writeFile(paths.claim, "", { mode: 0o644 });
    await expect(publisher.publishVersion(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    await rm(paths.claim);
    const replacing = await initializeTargetSecretSourceFsPublish({
      hookForTest: async (phase) => {
        if (phase === "before_directory_sync") await rm(home, { recursive: true, force: true });
      }
    });
    await expect(replacing.publishVersion(input)).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("contains no scan, lease, process, clock, native, or temporary-file machinery", async () => {
    const wrapper = await readFile(new URL("./targetSecretSourceFsPublish.ts", import.meta.url), "utf8");
    const primitive = await readFile(new URL("./targetSecretSourceFsPublishImmutable.ts", import.meta.url), "utf8");
    for (const forbidden of ["readdir", "process.pid", "Date.now", "lease", "unlinkat", ".tmp", "temporary"]) {
      expect(wrapper).not.toContain(forbidden);
      expect(primitive).not.toContain(forbidden);
    }
    expect(wrapper).toContain("initializeTargetSecretSourceFsPublishImmutable");
    expect(primitive).toContain("await link(token, claim)");
    expect(resolveTargetSecretVersionsDirectory()).not.toContain("publication");
  });
});
