import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkBuiltTree } from "./workspaceBundleTree.js";

describe("built output walk", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-tree-")); });
  afterEach(async () => { await rm(root, { force: true, recursive: true }); });

  it("content-addresses every regular file in sorted order, honouring skip and dropped symlinks", async () => {
    await mkdir(path.join(root, "b/c"), { recursive: true });
    await writeFile(path.join(root, "b/c/z.txt"), "z");
    await writeFile(path.join(root, "a.txt"), "a", { mode: 0o755 });
    await writeFile(path.join(root, "skipped.txt"), "s");
    await symlink("a.txt", path.join(root, "link"));
    const input = await walkBuiltTree(root, { dropSymlink: (relative) => relative === "link", skip: (relative) => relative === "skipped.txt" });
    expect(input.entries.map((entry) => [entry.path, entry.mode, entry.identity.slice(0, 7)])).toEqual([["a.txt", 0o755, "sha256:"], ["b/c/z.txt", 0o644, "sha256:"]]);
    await expect(walkBuiltTree(root)).rejects.toThrow(/symlink: link/u);
  });

  it("refuses empty output", async () => {
    await mkdir(path.join(root, "empty"));
    await expect(walkBuiltTree(root)).rejects.toThrow(/output is empty/u);
  });
});
