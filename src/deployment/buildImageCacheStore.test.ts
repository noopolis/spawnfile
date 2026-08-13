import { createHash } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";

import {
  BUILD_IMAGE_CACHE_VERSION,
  createBuildImageCacheKey,
  readBuildImageCacheEntry,
  resolveBuildImageCachePath,
  type BuildImageCacheEntry,
  writeBuildImageCacheEntry
} from "./buildImageCacheStore.js";

const previousHome = process.env.SPAWNFILE_HOME;
let homeDirectory: string;

const createEntry = (
  overrides: Partial<BuildImageCacheEntry> = {}
): BuildImageCacheEntry => ({
  compileFingerprint: "sf1:abc123",
  contextDigest: `sha256:${"a".repeat(64)}`,
  dockerContext: null,
  imageId: "sha256:image-id",
  imageTag: "spawnfile-project",
  projectRoot: "/tmp/project/Spawnfile",
  version: BUILD_IMAGE_CACHE_VERSION,
  writtenAt: "2026-07-30T12:00:00.000Z",
  ...overrides
});

beforeEach(async () => {
  homeDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-build-cache-"));
  process.env.SPAWNFILE_HOME = homeDirectory;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousHome;
  }
  await removeDirectory(homeDirectory).catch(() => undefined);
});

describe("build image cache store", () => {
  it("keys entries by project root, image tag, and Docker context", () => {
    const input = {
      dockerContext: "remote",
      imageTag: "spawnfile-project",
      projectRoot: "/tmp/project/Spawnfile"
    };
    expect(createBuildImageCacheKey(input)).toBe(
      createHash("sha256")
        .update("/tmp/project/Spawnfile\0spawnfile-project\0remote")
        .digest("hex")
    );
    expect(createBuildImageCacheKey({ ...input, dockerContext: null }))
      .not.toBe(createBuildImageCacheKey(input));
  });

  it("atomically writes mode-0600 entries and reads them through the strict schema", async () => {
    const entry = createEntry();
    await expect(writeBuildImageCacheEntry(entry)).resolves.toBe(true);
    await expect(readBuildImageCacheEntry(entry)).resolves.toEqual(entry);
    expect((await stat(resolveBuildImageCachePath(entry))).mode & 0o777).toBe(0o600);
  });

  it("treats absent, malformed, and shape-invalid entries as cache misses", async () => {
    const entry = createEntry();
    await expect(readBuildImageCacheEntry(entry)).resolves.toBeNull();

    const cachePath = resolveBuildImageCachePath(entry);
    await writeBuildImageCacheEntry(entry);
    await writeUtf8File(cachePath, "{not-json");
    await expect(readBuildImageCacheEntry(entry)).resolves.toBeNull();

    await writeUtf8File(cachePath, JSON.stringify({ ...entry, unexpected: true }));
    await expect(readBuildImageCacheEntry(entry)).resolves.toBeNull();
  });

  it("never throws when the cache path cannot be written", async () => {
    const blockingPath = path.join(homeDirectory, "not-a-directory");
    await writeUtf8File(blockingPath, "x");
    process.env.SPAWNFILE_HOME = blockingPath;

    await expect(writeBuildImageCacheEntry(createEntry())).resolves.toBe(false);
    await expect(readBuildImageCacheEntry(createEntry())).resolves.toBeNull();
  });
});
