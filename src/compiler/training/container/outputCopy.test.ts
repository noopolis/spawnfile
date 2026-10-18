import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { trainingOutputCopyProgram } from "./outputCopy.js";
const run = promisify(execFile), roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(path.join(root, "from/readonly"), 0o700).catch(() => {});
    await chmod(path.join(root, "to/readonly"), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "output-copy-")); roots.push(root);
  const from = path.join(root, "from"), to = path.join(root, "to");
  await mkdir(from); await mkdir(to);
  const copy = () => run(process.execPath, ["-e", trainingOutputCopyProgram, from, to, String(process.getuid!()), String(process.getgid!())], { timeout: 5000 });
  return { root, from, to, copy };
};
it("copies hidden files, modes, empty directories, hardlinks and symlinks without reading their targets", async () => {
  const f = await fixture();
  await mkdir(path.join(f.from, "readonly")); await chmod(path.join(f.from, "readonly"), 0o500);
  await mkdir(path.join(f.from, "empty"));
  await writeFile(path.join(f.from, ".checkpoint"), "checkpoint", { mode: 0o640 });
  await writeFile(path.join(f.from, "executable"), "bytes", { mode: 0o6751 });
  await link(path.join(f.from, "executable"), path.join(f.from, "alias"));
  await chmod(path.join(f.from, "executable"), 0o6751);
  // Managed hosts may strip set-id bits even from chmod; preserve the actual source mode.
  const sourceMode = (await stat(path.join(f.from, "executable"))).mode & 0o7777;
  await symlink("/definitely/missing/private", path.join(f.from, "external"));
  await symlink(".checkpoint", path.join(f.from, "relative"));
  expect((await f.copy()).stdout.trim()).toBe("spawnfile-output-copy-complete");
  expect(await readFile(path.join(f.to, ".checkpoint"), "utf8")).toBe("checkpoint");
  expect((await stat(path.join(f.to, ".checkpoint"))).mode & 0o777).toBe(0o640);
  expect((await stat(path.join(f.to, "executable"))).mode & 0o7777).toBe(sourceMode);
  expect((await stat(path.join(f.to, "readonly"))).mode & 0o777).toBe(0o500);
  expect((await stat(path.join(f.to, "empty"))).isDirectory()).toBe(true);
  expect((await stat(path.join(f.to, "alias"))).ino).toBe((await stat(path.join(f.to, "executable"))).ino);
  expect(await readlink(path.join(f.to, "external"))).toBe("/definitely/missing/private");
  expect(await readlink(path.join(f.to, "relative"))).toBe(".checkpoint");
  expect((await lstat(f.to)).uid).toBe(process.getuid!());
});
it("refuses special files, oversized sparse files, deep trees and nonempty destinations", async () => {
  for (const kind of ["special", "size", "depth", "nonempty"]) {
    const f = await fixture();
    if (kind === "special") await run("mkfifo", [path.join(f.from, "pipe")]);
    if (kind === "size") { await writeFile(path.join(f.from, "large"), ""); await truncate(path.join(f.from, "large"), 64 * 1024 ** 3 + 1); }
    if (kind === "depth") { let dir = f.from; for (let i = 0; i < 65; i++) { dir = path.join(dir, "d"); await mkdir(dir); } }
    if (kind === "nonempty") await writeFile(path.join(f.to, "existing"), "keep");
    await expect(f.copy()).rejects.toThrow(/special file|64 GiB|depth limit|must be empty/u);
  }
});
it("refuses a destination symlink without changing the outside directory", async () => {
  const f = await fixture(), outside = path.join(f.root, "outside");
  await mkdir(outside); await writeFile(path.join(outside, "keep"), "safe");
  await rm(f.to, { recursive: true }); await symlink(outside, f.to);
  await expect(f.copy()).rejects.toThrow();
  expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("safe");
});
