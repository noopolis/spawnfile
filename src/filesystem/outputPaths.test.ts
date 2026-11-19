import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { assertOutputRelativePath, resolveOutputFilePaths } from "./outputPaths.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const newRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-output-paths-"));
  roots.push(root);
  return root;
};

it("resolves normal nested and hidden files in a compiler output scope", async () => {
  const root = await newRoot();
  await expect(resolveOutputFilePaths(root, ["config.json", "workspace/.spawnfile/Team Notes.md"], "runtimes/example"))
    .resolves.toEqual([
      path.join(root, "runtimes/example/config.json"),
      path.join(root, "runtimes/example/workspace/.spawnfile/Team Notes.md")
    ]);
});

it.each(["", ".", "workspace/", "workspace//notes.md", "./config.json", "workspace\\notes.md", "/workspace/config.json", "workspace/../config.json"])(
  "rejects a noncanonical emitted filename %j",
  (filename) => expect(() => assertOutputRelativePath(filename)).toThrow(/relative file path|forward slashes/u)
);

it("rejects paths that would need to be both a file and a directory", async () => {
  await expect(resolveOutputFilePaths(await newRoot(), ["workspace", "workspace/notes.md"]))
    .rejects.toThrow(/also a directory/u);
});

it("refuses to replace an existing non-file destination or a non-directory parent", async () => {
  const root = await newRoot();
  await mkdir(path.join(root, "workspace"));
  await writeFile(path.join(root, "config.json"), "{}\n");
  await expect(resolveOutputFilePaths(root, ["workspace"])).rejects.toThrow(/regular file with one link/u);
  await expect(resolveOutputFilePaths(root, ["config.json/details.md"])).rejects.toThrow(/real directory/u);
});
