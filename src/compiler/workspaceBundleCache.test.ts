import { createHash } from "node:crypto";
import { chmod, readdir, readFile, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lookupCachedBundle, pruneBundleCache, resolveWorkspaceBundleCacheDirectory, storeBuiltBundle } from "./workspaceBundleCache.js";
import { BundleTarWriter } from "./workspaceBundleTar.js";

const key = (character: string) => character.repeat(64);
const build = (content: string) => async (temporaryPath: string) => {
  const writer = await BundleTarWriter.create(temporaryPath);
  await writer.begin("file.txt", content.length, 0o644);
  await writer.data(Buffer.from(content));
  await writer.end();
  return writer.finish();
};

describe("workspace bundle cache", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-cache-")); });
  afterEach(async () => { await rm(directory, { force: true, recursive: true }); });

  it("defaults under the Spawnfile home and honours an override", () => {
    const previous = process.env.SPAWNFILE_HOME;
    process.env.SPAWNFILE_HOME = "/tmp/spawnfile-home";
    try {
      expect(resolveWorkspaceBundleCacheDirectory()).toBe("/tmp/spawnfile-home/cache/workspace-bundles");
      expect(resolveWorkspaceBundleCacheDirectory("/elsewhere")).toBe("/elsewhere");
    } finally {
      if (previous === undefined) delete process.env.SPAWNFILE_HOME; else process.env.SPAWNFILE_HOME = previous;
    }
  });

  it("stores atomically, hits by key, and misses on any change to the archive", async () => {
    const cache = path.join(directory, "cache");
    expect(await lookupCachedBundle(cache, key("a"))).toBeUndefined();
    const stored = await storeBuiltBundle(cache, key("a"), build("one"));
    expect(stored.tarPath).toBe(path.join(cache, `${key("a")}.${stored.sha256.slice(7)}.tar`));
    expect((await readdir(cache)).sort()).toEqual([`${key("a")}.${stored.sha256.slice(7)}.tar`, `${key("a")}.json`]);
    expect(await lookupCachedBundle(cache, key("a"))).toEqual(stored);
    expect((await stat(stored.tarPath)).mode & 0o777).toBe(0o444);
    await expect(writeFile(stored.tarPath, "tampered")).rejects.toThrow();
    await chmod(stored.tarPath, 0o644);
    expect(await lookupCachedBundle(cache, key("a"))).toBeUndefined();
    await chmod(stored.tarPath, 0o444);
    expect(await lookupCachedBundle(cache, key("a"))).toBeDefined();
    await chmod(stored.tarPath, 0o644);
    await writeFile(stored.tarPath, "tampered");
    expect(await lookupCachedBundle(cache, key("a"))).toBeUndefined();
    await writeFile(path.join(cache, `${key("b")}.json`), "{not json");
    expect(await lookupCachedBundle(cache, key("b"))).toBeUndefined();
  });

  it("never pairs one concurrent writer's digest with another writer's bytes", async () => {
    const cache = path.join(directory, "cache");
    const [left, right] = await Promise.all([storeBuiltBundle(cache, key("e"), build("left")), storeBuiltBundle(cache, key("e"), build("right"))]);
    const digestOf = async (file: string) => `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
    expect(await digestOf(left.tarPath)).toBe(left.sha256);
    expect(await digestOf(right.tarPath)).toBe(right.sha256);
    const hit = (await lookupCachedBundle(cache, key("e")))!;
    expect(await digestOf(hit.tarPath)).toBe(hit.sha256);
  });

  it("validates before publishing and leaves nothing behind on failure", async () => {
    const cache = path.join(directory, "cache");
    await expect(storeBuiltBundle(cache, key("c"), async (temporaryPath) => {
      await writeFile(temporaryPath, Buffer.alloc(1024));
      return { contentBytes: 0, fileCount: 0, sha256: `sha256:${key("0")}`, size: 1024 };
    })).rejects.toThrow(/empty/u);
    expect(await readdir(cache)).toEqual([]);
  });

  it("prunes the least recently used archives but never one in use", async () => {
    const cache = path.join(directory, "cache");
    for (const [index, character] of ["a", "b", "c", "d"].entries()) {
      await storeBuiltBundle(cache, key(character), build(character));
      const when = new Date(Date.UTC(2026, 0, 1 + index));
      await utimes(path.join(cache, `${key(character)}.json`), when, when);
      if (character === "b") await storeBuiltBundle(cache, key("b"), build("b-variant")).then(() => utimes(path.join(cache, `${key("b")}.json`), when, when));
    }
    await pruneBundleCache(cache, new Set([key("a")]), 2, Date.UTC(2026, 0, 1, 12));
    expect((await readdir(cache)).filter((name) => name.endsWith(".tar"))).toHaveLength(5);
    await pruneBundleCache(cache, new Set([key("a")]), 2, Date.UTC(2026, 1, 1));
    expect((await readdir(cache)).filter((name) => name.endsWith(".tar")).map((name) => name.slice(0, 64)).sort()).toEqual([key("a"), key("c"), key("d")]);
    await pruneBundleCache(path.join(directory, "missing"), new Set());
  });
});
