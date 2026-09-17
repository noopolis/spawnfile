import { chmod, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sealFile, sealTree } from "./files.js";
import { openSealMemo, trainingSealMemoPath } from "./sealMemo.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => { vi.mocked(fsPromises.open).mockClear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "training-seal-memo-"))); roots.push(root); return root; }
const opensOf = (file: string) => vi.mocked(fsPromises.open).mock.calls.filter(call => call[0] === file).length;
const memoOptions = { racySafetyNs: 0n };

it("reuses a persisted digest without opening or reading the source bytes", async () => {
  const root = await fixture(), source = path.join(root, "grok"), memoPath = path.join(root, "cache", "training-seal.v1.json");
  await writeFile(source, "native-binary");
  const first = await openSealMemo(memoPath, memoOptions);
  const sealed = await sealFile(source, "grok", first); await first.save();
  expect(opensOf(source)).toBe(1);
  expect((await stat(memoPath)).mode & 0o777).toBe(0o600);
  const second = await openSealMemo(memoPath, memoOptions);
  expect(await sealFile(source, "grok", second)).toEqual(sealed);
  expect(opensOf(source)).toBe(1);
  expect(await sealFile(source, "grok")).toEqual(sealed);
  expect(opensOf(source)).toBe(2);
});

it("rehashes when content changes under a restored mtime because ctime is part of the key", async () => {
  const root = await fixture(), source = path.join(root, "grok"), memoPath = path.join(root, "memo.json");
  await writeFile(source, "AAAA");
  // Whole-second times restore exactly, so only ctime can distinguish the rewrite.
  const pinned = new Date("2020-01-01T00:00:00Z"); await utimes(source, pinned, pinned);
  const memo = await openSealMemo(memoPath, memoOptions);
  const original = await sealFile(source, "grok", memo); await memo.save();
  const before = await stat(source, { bigint: true });
  await writeFile(source, "BBBB"); await utimes(source, pinned, pinned);
  const after = await stat(source, { bigint: true });
  expect([after.mtimeNs, after.size, after.ino, after.dev]).toEqual([before.mtimeNs, before.size, before.ino, before.dev]);
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
  const reopened = await openSealMemo(memoPath, memoOptions);
  const changed = await sealFile(source, "grok", reopened);
  expect(changed.sha256).not.toBe(original.sha256);
  expect(changed.sha256).toBe((await sealFile(source, "grok")).sha256);
});

it("does not memoize racily fresh files and tolerates corrupt, foreign-mode or unwritable memos", async () => {
  const root = await fixture(), source = path.join(root, "file"), memoPath = path.join(root, "memo.json");
  await writeFile(source, "fresh");
  const fresh = await openSealMemo(memoPath); await sealFile(source, "file", fresh); await fresh.save();
  await expect(stat(memoPath)).rejects.toThrow();
  for (const [body, mode] of [["{not json", 0o600], [JSON.stringify({ version: "other", entries: [] }), 0o600],
    [JSON.stringify({ version: "spawnfile.training-seal-memo.v1", entries: [[`["${source}"]`, "sha256:bad"], "x"] }), 0o600],
    [JSON.stringify({ version: "spawnfile.training-seal-memo.v1", entries: {} }), 0o600]] as const) {
    await writeFile(memoPath, body); await chmod(memoPath, mode);
    const memo = await openSealMemo(memoPath, memoOptions);
    expect((await sealFile(source, "file", memo)).sha256).toMatch(/^sha256:/u);
    await memo.save();
    expect(JSON.parse(await readFile(memoPath, "utf8")).entries).toHaveLength(1);
  }
  await chmod(memoPath, 0o644);
  const opened = opensOf(source);
  await sealFile(source, "file", await openSealMemo(memoPath, memoOptions));
  expect(opensOf(source)).toBe(opened + 1);
  const blocked = path.join(root, "blocked"); await writeFile(blocked, "not a directory");
  const unwritable = await openSealMemo(path.join(blocked, "memo.json"), memoOptions);
  await sealFile(source, "file", unwritable);
  await expect(unwritable.save()).resolves.toBeUndefined();
});

it("bounds retained entries and defaults to the private Spawnfile cache", async () => {
  const root = await fixture(), memoPath = path.join(root, "memo.json");
  for (const name of ["a", "b", "c", "d"]) await writeFile(path.join(root, "tree", name).replace("/tree/", "/tree-"), name);
  const memo = await openSealMemo(memoPath, { ...memoOptions, maxEntries: 2 });
  for (const name of ["a", "b", "c", "d"]) await sealFile(path.join(root, `tree-${name}`), name, memo);
  await memo.save();
  expect(JSON.parse(await readFile(memoPath, "utf8")).entries).toHaveLength(2);
  expect(trainingSealMemoPath()).toBe(path.join(path.resolve(process.env.SPAWNFILE_HOME ?? path.join(os.homedir(), ".spawnfile")), "cache", "training-seal.v1.json"));
  const tree = path.join(root, "dir"); await fsPromises.mkdir(tree); await writeFile(path.join(tree, "x"), "x");
  const treeMemo = await openSealMemo(memoPath, memoOptions);
  const sealed = await sealTree(tree, "dir", { memo: treeMemo });
  expect(await sealTree(tree, "dir", { memo: treeMemo })).toEqual(sealed);
  expect(opensOf(path.join(tree, "x"))).toBe(1);
});
