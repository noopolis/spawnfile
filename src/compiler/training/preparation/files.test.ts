import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { assertInputRoot, copySealed, exactPath, sealFile, sealTree } from "./files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "training-files-"))); roots.push(root); return root; }
it("rejects protected roots, credential containment and leaf aliases", async () => {
  for (const root of ["/", os.homedir(), path.join(os.homedir(), ".claude/settings"), "/private/data"]) {
    expect(() => assertInputRoot(root, ["/private/data/auth"])).toThrow();
  }
  const root = await fixture(); await writeFile(path.join(root, "file"), "bytes"); await symlink(path.join(root, "file"), path.join(root, "alias"));
  await expect(exactPath(path.join(root, "alias"))).rejects.toThrow("canonical");
  await expect(sealFile(root, "root")).rejects.toThrow("regular file");
  await truncate(path.join(root, "file"), 536870913); await expect(sealFile(path.join(root, "file"), "file")).rejects.toThrow("512 MiB");
});
it("preserves confined documentation links but rejects escaping, cyclic and deep trees", async () => {
  const root = await fixture(); await writeFile(path.join(root, "AGENTS.md"), "guide"); await symlink("AGENTS.md", path.join(root, "CLAUDE.md"));
  expect(await sealTree(root, "input", { internalSymlinks: true })).toHaveLength(2);
  await expect(sealTree(root, "image")).rejects.toThrow("symlinks");
  await symlink("../", path.join(root, "escape")); await expect(sealTree(root, "input", { internalSymlinks: true })).rejects.toThrow("symlinks"); await rm(path.join(root, "escape"));
  await symlink(".", path.join(root, "cycle")); await expect(sealTree(root, "input", { internalSymlinks: true })).rejects.toThrow("bounds"); await rm(path.join(root, "cycle"));
  let nested = root; for (let index = 0; index < 34; index++) { nested = path.join(nested, "nested"); await mkdir(nested); }
  await expect(sealTree(root, "input", { ignoreDevelopment: true })).rejects.toThrow("bounds");
});
it("does not allow a crafted sealed destination to write outside its owned staging", async () => {
  const root = await fixture(), file = path.join(root, "source"); await writeFile(file, "bytes");
  const sealed = await sealFile(file, "../escape");
  await expect(copySealed([sealed], root)).rejects.toThrow("escapes");
});
