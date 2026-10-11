import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeakCheck, MaterializedInput } from "./contract.js";
import { materializeCleanRepository } from "./git.js";
import { commitTestGit, gitTestRoot, initTestGit, testGit } from "./git.test-helper.js";
import { inspectGitBundle } from "./leakGit.js";
import { stampTree } from "./timestamps.js";
import * as gitProcess from "./gitProcess.js";

const AT = "2026-10-09T08:20:31Z", BEFORE = "2026-10-09T08:00:00Z";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await gitTestRoot(); roots.push(root);
  const source = path.join(root, "source"), repository = path.join(root, "output");
  await initTestGit(source);
  await symlink("data.txt", path.join(source, "link"));
  const commit = await commitTestGit(source, { "data.txt": "past bytes", ".gitignore": "ignored.txt\n", "folder/child": "child" }, BEFORE);
  await materializeCleanRepository(source, commit, repository);
  const input: MaterializedInput = { section: "resources", declaredBy: "agent:writer", id: "code", kind: "git",
    fidelity: "exact", basis: "record", source: { commit }, path: "resources/code", notes: [], refusal: null };
  const inspect = async () => {
    const report: LeakCheck = { version: "spawnfile.leak-check.v1", at: AT, ok: false,
      checked: { files: 0, gitObjects: 0, memoryEvents: 0, moltnetMessages: 0, moltnetEvents: 0, snapshots: 0 }, findings: [] };
    await inspectGitBundle(repository, input, report);
    return report.findings;
  };
  return { source, repository, inspect };
};

describe("independent git payload inspection", () => {
  it("rebuilds the checked-out index without materialization-time stat fields", async () => {
    const f = await fixture();
    const debug = testGit(f.repository, ["ls-files", "--debug"]);
    const times = [...debug.matchAll(/(?:ctime|mtime): (\d+):(\d+)/gu)];
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((match) => match[1] === "0" && match[2] === "0")).toBe(true);
    expect(await f.inspect()).toEqual([]);
  });

  it("clears refreshed checkout stat fields before publishing", async () => {
    const run = gitProcess.rewindGit;
    // Some git versions leave checkout-index stat fields zero already. Populate real
    // checkout stats at this boundary so deleting the rebuild cannot silently pass.
    const checkout = vi.spyOn(gitProcess, "rewindGit").mockImplementation(async (repo, args, input) => {
      const result = await run(repo, args, input);
      if (args[0] === "checkout-index") {
        await run(repo, ["update-index", "--refresh"]);
        const populated = (await run(repo, ["ls-files", "--debug"])).toString();
        expect([...populated.matchAll(/ctime: (\d+):/gu)].some((match) => Number(match[1]) > Date.parse(AT) / 1000)).toBe(true);
      }
      return result;
    });
    const f = await fixture(); checkout.mockRestore();
    expect(await f.inspect()).toEqual([]);
    const times = [...testGit(f.repository, ["ls-files", "--debug"]).matchAll(/(?:ctime|mtime): (\d+):(\d+)/gu)];
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((match) => match[1] === "0" && match[2] === "0")).toBe(true);
  });

  it.each(["changed", "missing", "untracked", "ignored", "extra-directory", "mode", "symlink", "index-disguised"])
    ("rejects %s worktree content against local ls-tree blobs", async (mutation) => {
      const f = await fixture();
      expect(await f.inspect()).toEqual([]);
      // Source history is unavailable: this comparison must use the bundle repository itself.
      await rm(f.source, { recursive: true });
      if (["changed", "index-disguised"].includes(mutation)) await writeFile(path.join(f.repository, "data.txt"), "later data");
      if (mutation === "index-disguised") {
        testGit(f.repository, ["add", "data.txt"]);
        testGit(f.repository, ["update-index", "--assume-unchanged", "data.txt"]);
      }
      if (mutation === "missing") await rm(path.join(f.repository, "data.txt"));
      if (mutation === "untracked" || mutation === "ignored") await writeFile(path.join(f.repository, `${mutation}.txt`), "later data");
      if (mutation === "extra-directory") await mkdir(path.join(f.repository, "extra"));
      if (mutation === "mode") await chmod(path.join(f.repository, "data.txt"), 0o755);
      if (mutation === "symlink") { await rm(path.join(f.repository, "link")); await symlink("folder/child", path.join(f.repository, "link")); }
      await stampTree(f.repository, BEFORE, AT);
      expect(await f.inspect()).toContainEqual(expect.objectContaining({ class: "git-object", detail: expect.stringMatching(/git worktree/iu) }));
    });

  it.each(["ctime", "mtime"])("rejects future index %s after filesystem timestamps are stamped", async (field) => {
    const f = await fixture(), file = path.join(f.repository, ".git/index");
    expect(await f.inspect()).toEqual([]);
    const bytes = await readFile(file);
    expect(bytes.subarray(0, 4).toString()).toBe("DIRC");
    expect(bytes.readUInt32BE(8)).toBeGreaterThan(0);
    bytes.writeUInt32BE(Math.floor(Date.parse(AT) / 1000) + 1, 12 + (field === "ctime" ? 0 : 8));
    createHash("sha1").update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20);
    await writeFile(file, bytes); await stampTree(f.repository, BEFORE, AT);
    expect(await f.inspect()).toContainEqual(expect.objectContaining({ class: "git-object", detail: expect.stringContaining(`Git index ${field} is later`) }));
  });
});
