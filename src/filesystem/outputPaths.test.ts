import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { assertOutputRelativePath, readStagedRegularFiles, resolveOutputFilePaths, resolveOutputRoot } from "./outputPaths.js";

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

it("follows an operator-selected output root link to a real directory but not links below it", async () => {
  const root = await newRoot();
  await mkdir(path.join(root, "real/nested"), { recursive: true });
  await symlink(path.join(root, "real"), path.join(root, "out"));
  const target = await realpath(path.join(root, "real"));
  await expect(resolveOutputRoot(path.join(root, "out"))).resolves.toBe(target);
  await expect(resolveOutputFilePaths(path.join(root, "out"), ["config.json"], "runtimes/example"))
    .resolves.toEqual([path.join(target, "runtimes/example/config.json")]);
  await symlink(path.join(root, "real/nested"), path.join(root, "real/linked"));
  await expect(resolveOutputFilePaths(path.join(root, "out"), ["linked/config.json"])).rejects.toThrow(/real directory/u);
});

it("refuses unusable output roots", async () => {
  const root = await newRoot();
  await writeFile(path.join(root, "file"), "{}\n");
  await symlink(path.join(root, "file"), path.join(root, "file-link"));
  await symlink(path.join(root, "missing"), path.join(root, "dangling"));
  for (const target of ["file", "file-link", "dangling"]) {
    await expect(resolveOutputRoot(path.join(root, target))).rejects.toThrow(/real directory/u);
  }
  await expect(resolveOutputRoot(path.join(root, "absent"))).resolves.toBe(path.join(root, "absent"));
});

it("reads expected staged regular files and refuses links", async () => {
  const root = await newRoot();
  await mkdir(path.join(root, "skills/moltnet"), { recursive: true });
  await writeFile(path.join(root, "skills/moltnet/SKILL.md"), "skill\n");
  await expect(readStagedRegularFiles(root, ["skills/moltnet/SKILL.md"])).resolves.toEqual(["skill\n"]);
  await symlink(path.join(root, "skills/moltnet/SKILL.md"), path.join(root, "linked.md"));
  await link(path.join(root, "skills/moltnet/SKILL.md"), path.join(root, "hard.md"));
  await expect(readStagedRegularFiles(root, ["linked.md"])).rejects.toThrow(/one link/u);
  await expect(readStagedRegularFiles(root, ["hard.md"])).rejects.toThrow(/one link/u);
  await expect(readStagedRegularFiles(root, ["absent.md"])).rejects.toThrow(/was not produced/u);
  await expect(readStagedRegularFiles(root, ["../escape.md"])).rejects.toThrow(/canonical relative file path/u);
});
