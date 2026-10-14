import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { copySealed, fileIdentity, hashJson, sealFile, sealTree } from "./files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); }, 60_000);
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "training-links-")));
  roots.push(root);
  const source = path.join(root, "source"), staged = path.join(root, "staged");
  await mkdir(source); await mkdir(staged);
  return { root, source, staged };
}

// The full coverage run competes for filesystem I/O while sealing and staging all 6993 files.
it("seals 6993 physical feed files across four moments once and stages readable current links", async () => {
  const { source, staged } = await fixture();
  for (let moment = 0; moment < 4; moment++) {
    const feed = path.join(source, `moment-${moment}/resources/public-content-volume`);
    const tree = path.join(feed, "trees/rev"); await mkdir(tree, { recursive: true });
    const count = moment === 0 ? 1749 : 1748;
    for (let start = 0; start < count; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, count - start) }, (_, index) =>
        writeFile(path.join(tree, `${start + index}.txt`), `moment ${moment} file ${start + index}`)));
    }
    await symlink("trees/rev", path.join(feed, "current"));
  }
  const files = await sealTree(source, "", { internalSymlinks: true });
  expect(files.filter(file => file.target === undefined), "physical feed inventory guarantee").toHaveLength(6993);
  expect(files).toHaveLength(6997);
  await copySealed(files, staged);
  for (let moment = 0; moment < 4; moment++) {
    const current = path.join(staged, `moment-${moment}/resources/public-content-volume/current`);
    expect((await lstat(current)).isSymbolicLink(), "feed staging link guarantee").toBe(true);
    expect(await readlink(current)).toBe("trees/rev");
    expect(await readFile(path.join(current, "0.txt"), "utf8")).toBe(`moment ${moment} file 0`);
  }
  const snapshot = await sealTree(staged, "", { internalSymlinks: true });
  expect(hashJson(fileIdentity(snapshot)), "feed snapshot stability guarantee").toBe(hashJson(fileIdentity(files)));
}, 180_000);

it("records link type and target without duplicating payload, with stable relocatable digests", async () => {
  const { source, staged } = await fixture();
  await writeFile(path.join(source, "payload"), "same bytes");
  await writeFile(path.join(source, "other"), "same bytes");
  await symlink("payload", path.join(source, "current"));
  const seal = (root: string) => sealTree(root, "", { internalSymlinks: true });
  const files = await seal(source), identity = fileIdentity(files), digest = hashJson(identity);
  expect(files, "link inventory guarantee").toHaveLength(3);
  expect(identity.find(file => file.destination === "current"), "link identity guarantee")
    .toMatchObject({ type: "symlink", target: "payload", size: Buffer.byteLength("payload") });
  expect(hashJson(fileIdentity(await seal(source)))).toBe(digest);
  await copySealed(files, staged);
  expect((await lstat(path.join(staged, "current"))).isSymbolicLink(), "link copy guarantee").toBe(true);
  expect(await readlink(path.join(staged, "current"))).toBe("payload");
  expect(hashJson(fileIdentity(await seal(staged))), "link snapshot guarantee").toBe(digest);
  await rm(path.join(source, "current")); await symlink("other", path.join(source, "current"));
  const changed = await seal(source);
  expect(changed.find(file => file.target)?.sha256, "link target digest guarantee").not.toBe(files.find(file => file.target)?.sha256);
  expect(hashJson(fileIdentity(changed))).not.toBe(digest);
  await writeFile(path.join(source, "other"), "changed bytes");
  expect(hashJson(fileIdentity(await seal(source)))).not.toBe(hashJson(fileIdentity(changed)));
  await rm(path.join(source, "current")); await writeFile(path.join(source, "current"), "same bytes");
  expect(hashJson(fileIdentity(await seal(source)))).not.toBe(digest);
});

it.each(["relative", "absolute", "indirect"])("refuses %s escaping symlinks", async kind => {
  const { root, source } = await fixture(); await writeFile(path.join(root, "outside"), "outside");
  if (kind === "indirect") await symlink("../outside", path.join(source, "pivot"));
  await symlink(kind === "absolute" ? path.join(root, "outside") : kind === "indirect" ? "pivot" : "../outside",
    path.join(source, "current"));
  await expect(sealTree(source, "", { internalSymlinks: true }), "escaping link refusal guarantee").rejects.toThrow("escaping symlinks");
});

it("rejects link mutation during staging and a staging parent that aliases outside", async () => {
  const { root, source, staged } = await fixture();
  await writeFile(path.join(source, "payload"), "bytes"); await symlink("payload", path.join(source, "current"));
  const files = await sealTree(source, "", { internalSymlinks: true });
  await rm(path.join(source, "current")); await symlink(".", path.join(source, "current"));
  await expect(copySealed(files, staged), "link mutation refusal guarantee").rejects.toThrow("changed during staging");
  const outside = path.join(root, "outside"); await mkdir(outside); await symlink(outside, path.join(staged, "alias"));
  const file = await sealFile(path.join(source, "payload"), "alias/new/copied");
  await expect(copySealed([file], staged)).rejects.toThrow("canonical");
  await expect(lstat(path.join(outside, "new"))).rejects.toThrow();
});

it("preserves empty directory targets and link chains without traversing them", async () => {
  const { source, staged } = await fixture(); await mkdir(path.join(source, "empty"));
  await symlink("empty", path.join(source, "middle")); await symlink("middle", path.join(source, "current"));
  await symlink(".", path.join(source, "cycle"));
  const files = await sealTree(source, "", { internalSymlinks: true });
  expect(files).toHaveLength(4);
  await copySealed(files, staged);
  expect(await readlink(path.join(staged, "current"))).toBe("middle");
  expect(await realpath(path.join(staged, "current"))).toBe(path.join(staged, "empty"));
  expect(await readlink(path.join(staged, "cycle"))).toBe(".");
  expect(hashJson(fileIdentity(await sealTree(staged, "", { internalSymlinks: true })))).toBe(hashJson(fileIdentity(files)));
});

it("enforces the 10000-entry boundary on physical files and link entries", async () => {
  const { source } = await fixture(); await writeFile(path.join(source, "payload"), "bytes");
  for (let start = 0; start < 9999; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 9999 - start) }, (_, index) =>
      symlink("payload", path.join(source, `link-${start + index}`))));
  }
  expect(await sealTree(source, "", { internalSymlinks: true })).toHaveLength(10000);
  await symlink("payload", path.join(source, "one-too-many"));
  await expect(sealTree(source, "", { internalSymlinks: true })).rejects.toThrow("bounds");
}, 90_000);

it("charges the 1 GiB bound for physical bytes once while retaining the byte limit", async () => {
  const { source } = await fixture(), size = 384 * 1024 * 1024;
  await writeFile(path.join(source, "payload"), ""); await truncate(path.join(source, "payload"), size);
  await symlink("payload", path.join(source, "first")); await symlink("payload", path.join(source, "second"));
  const files = await sealTree(source, "", { internalSymlinks: true });
  expect(files.reduce((sum, file) => sum + file.size, 0), "physical byte inventory guarantee").toBe(size + 14);
  for (const name of ["extra-1", "extra-2"]) {
    await writeFile(path.join(source, name), ""); await truncate(path.join(source, name), size);
  }
  await expect(sealTree(source, "", { internalSymlinks: true })).rejects.toThrow("bounds");
}, 90_000);
