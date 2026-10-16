import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanTrainingProjects, trainingProject } from "../plan/fixtures.test-helper.js";
import { snapshotTrainingSource } from "./snapshot.js";

afterEach(cleanTrainingProjects);
const fixture = async () => {
  const root = await trainingProject({}), source = path.join(root, "input"), target = path.join(root, "snapshot");
  await mkdir(source);
  await writeFile(path.join(source, "AGENTS.md"), "baseline");
  return { root, source, target };
};
// Write isolated fixture objects directly; never create a commit in either implementation worktree.
const gitFixture = async (source: string): Promise<string> => {
  await mkdir(path.join(source, ".git/refs"), { recursive: true });
  const object = async (kind: string, content: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(`${kind} ${content.length}\0`), content]);
    const sha = createHash("sha1").update(bytes).digest("hex");
    const directory = path.join(source, ".git/objects", sha.slice(0, 2));
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, sha.slice(2)), deflateSync(bytes));
    return sha;
  };
  const blob = await object("blob", Buffer.from("committed baseline"));
  const tree = await object("tree", Buffer.concat([Buffer.from("100644 AGENTS.md\0"), Buffer.from(blob, "hex")]));
  const commit = await object("commit", Buffer.from(`tree ${tree}\nauthor Fixture <fixture@invalid> 0 +0000\ncommitter Fixture <fixture@invalid> 0 +0000\n\nfixture\n`));
  await writeFile(path.join(source, ".git/HEAD"), commit + "\n");
  await writeFile(path.join(source, ".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
  return commit;
};

it("retains one independent Git identity and current pinned bytes without copying repository configuration", async () => {
  const f = await fixture(), commit = await gitFixture(f.source);
  await snapshotTrainingSource(f.source, f.target);
  const run = promisify(execFile);
  expect((await run("git", ["-C", f.target, "rev-parse", "HEAD"])).stdout.trim()).toBe(commit);
  expect((await run("git", ["-C", f.target, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim()).toBe(path.join(f.target, ".git"));
  expect(await readFile(path.join(f.target, "AGENTS.md"), "utf8")).toBe("baseline");
  expect(await readFile(path.join(f.target, ".git/config"), "utf8")).not.toBe(await readFile(path.join(f.source, ".git/config"), "utf8"));
});

it("omits development/run state and refuses credential aliases or scratch overlap", async () => {
  const f = await fixture();
  await mkdir(path.join(f.source, ".spawn"));
  await writeFile(path.join(f.source, ".spawn/large-state"), "ignored");
  await snapshotTrainingSource(f.source, f.target);
  expect(await readdir(f.target)).toEqual(["AGENTS.md"]);
  await expect(snapshotTrainingSource(f.source, path.join(f.source, "snapshot"))).rejects.toThrow("disjoint");
  await mkdir(path.join(f.source, ".runtime"));
  await symlink(".runtime", path.join(f.source, "alias"));
  await expect(snapshotTrainingSource(f.source, path.join(f.root, "second"))).rejects.toThrow("symlink escapes");
});

it("refuses absolute, outside and dangling links without retaining candidate state", async () => {
  for (const value of ["/absolute", "../../outside", "missing"]) {
    const f = await fixture();
    await symlink(value, path.join(f.source, "link"));
    await expect(snapshotTrainingSource(f.source, f.target)).rejects.toThrow();
  }
  const f = await fixture();
  await expect(snapshotTrainingSource(f.source, f.target, AbortSignal.abort())).rejects.toThrow();
  await symlink(f.source, path.join(f.root, "alias"));
  await expect(snapshotTrainingSource(path.join(f.root, "alias"), f.target)).rejects.toThrow("canonical");
});

it("bounds nested source trees before copying, rejects stale snapshot targets, and handles live cancellation", async () => {
  const f = await fixture();
  await mkdir(path.join(f.source, ...Array.from({ length: 33 }, () => "deep")), { recursive: true });
  await expect(snapshotTrainingSource(f.source, f.target)).rejects.toThrow("snapshot bounds");
  const g = await fixture();
  await mkdir(g.target);
  await expect(snapshotTrainingSource(g.source, g.target)).rejects.toThrow();
  const h = await fixture(), controller = new AbortController();
  controller.abort();
  await expect(snapshotTrainingSource(h.source, h.target, controller.signal)).rejects.toThrow();
});
