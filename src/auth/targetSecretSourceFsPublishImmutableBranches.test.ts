import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveAuthHome,
  resolveSpawnfileHome,
  resolveTargetSecretsRoot,
  resolveTargetSecretVersionPath,
  resolveTargetSecretVersionsDirectory,
} from "./paths.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceFsPublishImmutable } from "./targetSecretSourceFsPublishImmutable.js";
import { initializeTargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import { createTargetSecretSourceVersionRecordBytes } from "./targetSecretSourceVersionRecords.js";

const previousHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];

afterEach(async () => {
  if (previousHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = previousHome;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { force: true, recursive: true })));
});

const reject = async (options: unknown): Promise<void> => {
  await expect(
    initializeTargetSecretSourceFsPublishImmutable(options as never),
  ).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
};

const setup = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-immutable-branches-"));
  cleanup.push(home);
  await chmod(home, 0o700);
  process.env.SPAWNFILE_HOME = home;
  await initializeTargetSecretSourceFsRead();
  const chain = [
    resolveSpawnfileHome(),
    resolveAuthHome(),
    resolveTargetSecretsRoot(),
    resolveTargetSecretVersionsDirectory(),
  ];
  return { chain, home };
};

const validInput = () => {
  const packet = createTargetSecretSourceVersionRecordBytes(new Uint8Array([1]), {
    entropy: () => new Uint8Array(16).fill(2),
    publicationEntropy: () => new Uint8Array(16).fill(3),
  });
  return {
    bytes: packet.private_bytes,
    final_path: resolveTargetSecretVersionPath(packet.metadata.source_version_handle),
    publication_handle: packet.private_metadata.publication_handle,
    proveExact: () => undefined,
  };
};

describe("immutable target-secret publication validation branches", () => {
  it("rejects invalid initialization option shapes", async () => {
    await reject(undefined);
    await reject(null);
    await reject("invalid");
    await reject({});
    await reject({ directory_chain: "invalid" });
    await reject({ directory_chain: [] });
    await reject({ directory_chain: [1] });
    await reject({ directory_chain: [""] });
  });

  it("rejects non-directory, symbolic, and permissive directory roots", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "spawnfile-immutable-root-"));
    cleanup.push(base);
    const file = path.join(base, "file");
    await writeFile(file, "value");
    await reject({ directory_chain: [file] });

    const restricted = path.join(base, "restricted");
    await rm(restricted, { force: true, recursive: true });
    await mkdir(restricted, { mode: 0o700 });
    const alias = path.join(base, "alias");
    await symlink(restricted, alias);
    await reject({ directory_chain: [alias] });

    await chmod(restricted, 0o755);
    await reject({ directory_chain: [restricted] });
  });

  it("rejects every malformed publication input field", async () => {
    const { chain } = await setup();
    const publisher = await initializeTargetSecretSourceFsPublishImmutable({ directory_chain: chain });
    const input = validInput();
    const invalid: unknown[] = [
      undefined,
      null,
      "invalid",
      {},
      { ...input, bytes: [] },
      { ...input, final_path: 1 },
      { ...input, publication_handle: 1 },
      { ...input, proveExact: 1 },
      { ...input, bytes: new Uint8Array() },
      { ...input, bytes: new Uint8Array(65_537) },
      { ...input, final_path: "relative" },
      { ...input, final_path: path.resolve(chain.at(-1)!, "..", "outside") },
    ];
    for (const value of invalid) {
      await expect(publisher.publishImmutable(value as never)).rejects.toThrow(
        TARGET_SECRET_SOURCE_ERROR,
      );
    }
  });

  it("rejects a non-positive short-write limit at the exact write boundary", async () => {
    const { chain } = await setup();
    const publisher = await initializeTargetSecretSourceFsPublishImmutable({
      directory_chain: chain,
      maxWriteBytesForTest: 0,
    });
    await expect(publisher.publishImmutable(validInput())).rejects.toThrow(
      TARGET_SECRET_SOURCE_ERROR,
    );
  });

  it("rejects replacement of an anchored directory chain", async () => {
    const { chain } = await setup();
    const publisher = await initializeTargetSecretSourceFsPublishImmutable({ directory_chain: chain });
    const leaf = chain.at(-1)!;
    await rename(leaf, `${leaf}.replaced`);
    await mkdir(leaf, { mode: 0o700 });
    await expect(publisher.publishImmutable(validInput())).rejects.toThrow(
      TARGET_SECRET_SOURCE_ERROR,
    );
  });

  it("rejects oversized, mismatched, and permissive pre-existing final files", async () => {
    for (const kind of ["oversized", "mismatched", "permissive"] as const) {
      const { chain } = await setup();
      const publisher = await initializeTargetSecretSourceFsPublishImmutable({ directory_chain: chain });
      const input = validInput();
      const bytes = kind === "oversized"
        ? new Uint8Array(input.bytes.length + 1)
        : Uint8Array.from(input.bytes, (value, index) => index === 0 ? value ^ 0xff : value);
      await writeFile(input.final_path, bytes, { mode: kind === "permissive" ? 0o644 : 0o600 });
      await expect(publisher.publishImmutable(input)).rejects.toThrow(
        TARGET_SECRET_SOURCE_ERROR,
      );
    }
  });
});
