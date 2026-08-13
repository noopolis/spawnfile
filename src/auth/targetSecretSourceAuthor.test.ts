import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceAuthor } from "./targetSecretSourceAuthor.js";

const entropy = (value: number) => (): Uint8Array => new Uint8Array(16).fill(value);
const opaque = (value: number): string => `opaque_${value.toString(16).padStart(2, "0").repeat(16)}`;
const originalHome = process.env.SPAWNFILE_HOME;
const cleanup: string[] = [];

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const harness = async (aliasFailure = false) => {
  const published: Uint8Array[] = [];
  const publishVersion = vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
    published.push(bytes);
  });
  const publishAlias = vi.fn(async (bytes: Uint8Array) => {
    published.push(bytes);
    if (aliasFailure) throw new Error("simulated interruption");
  });
  const author = await initializeTargetSecretSourceAuthor({
    aliasEntropy: entropy(3),
    aliasPublicationEntropy: entropy(4),
    recordPublisher: { publishAlias },
    versionEntropy: entropy(1),
    versionPublicationEntropy: entropy(2),
    versionPublisher: { publishVersion }
  });
  return { author, publishAlias, published, publishVersion };
};

describe("targetSecretSourceAuthor", () => {
  it("publishes version before alias and returns only the public source handle", async () => {
    const { author, publishAlias, published, publishVersion } = await harness();
    const input = new Uint8Array([11, 22, 33]);
    const result = await author.authorVersion(input);

    expect(result).toEqual({ source_handle: opaque(3) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("source_version_handle");
    expect(result).not.toHaveProperty("publication_handle");
    expect(publishVersion.mock.invocationCallOrder[0]).toBeLessThan(publishAlias.mock.invocationCallOrder[0]!);
    expect(input).toEqual(new Uint8Array([11, 22, 33]));
    expect(published.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  });

  it("treats alias as commit point and exposes no handle after an incomplete publication", async () => {
    const { author, publishAlias, published, publishVersion } = await harness(true);
    await expect(author.authorVersion(new Uint8Array([44]))).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);

    expect(publishVersion).toHaveBeenCalledOnce();
    expect(publishAlias).toHaveBeenCalledOnce();
    expect(published.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  });

  it("publishes no alias when immutable version publication fails and clears owned bytes", async () => {
    const seen: Uint8Array[] = [];
    const publishAlias = vi.fn();
    const author = await initializeTargetSecretSourceAuthor({
      aliasEntropy: entropy(3),
      aliasPublicationEntropy: entropy(4),
      recordPublisher: { publishAlias },
      versionEntropy: entropy(1),
      versionPublicationEntropy: entropy(2),
      versionPublisher: {
        publishVersion: vi.fn(async ({ bytes }) => {
          seen.push(bytes);
          throw new Error("version failure");
        })
      }
    });

    await expect(author.authorVersion(new Uint8Array([55]))).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(publishAlias).not.toHaveBeenCalled();
    expect(seen[0]?.every((value) => value === 0)).toBe(true);
  });

  it.each([
    ["public alias handle", 2, 4],
    ["private alias publication handle", 3, 2]
  ])("rejects a cross-record collision in the %s before either publication", async (_label, aliasValue, aliasPublicationValue) => {
    const publishVersion = vi.fn();
    const publishAlias = vi.fn();
    const author = await initializeTargetSecretSourceAuthor({
      aliasEntropy: entropy(aliasValue),
      aliasPublicationEntropy: entropy(aliasPublicationValue),
      recordPublisher: { publishAlias },
      versionEntropy: entropy(1),
      versionPublicationEntropy: entropy(2),
      versionPublisher: { publishVersion }
    });

    await expect(author.authorVersion(new Uint8Array([77]))).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(publishVersion).not.toHaveBeenCalled();
    expect(publishAlias).not.toHaveBeenCalled();
  });

  it("initializes repeatedly in a fresh home and exactly replays the same authored records", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-author-"));
    cleanup.push(home);
    process.env.SPAWNFILE_HOME = home;
    const options = {
      aliasEntropy: entropy(3),
      aliasPublicationEntropy: entropy(4),
      versionEntropy: entropy(1),
      versionPublicationEntropy: entropy(2)
    };

    const first = await initializeTargetSecretSourceAuthor(options);
    expect(await first.authorVersion(new Uint8Array([66]))).toEqual({ source_handle: opaque(3) });
    const restarted = await initializeTargetSecretSourceAuthor(options);
    expect(await restarted.authorVersion(new Uint8Array([66]))).toEqual({ source_handle: opaque(3) });
  });
});
