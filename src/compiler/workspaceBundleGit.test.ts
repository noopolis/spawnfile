import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listCommittedTree, listIndex, readStableSnapshot, readStatus, readStatusAgainstHead, resolveGitLocation, streamBlobs } from "./workspaceBundleGit.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });

describe("workspace bundle git queries", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-git-"));
    await git(repo, "init", "-q");
    await mkdir(path.join(repo, "tools/deep"), { recursive: true });
    await writeFile(path.join(repo, "tools/a.txt"), "alpha");
    await writeFile(path.join(repo, "tools/empty"), "");
    await writeFile(path.join(repo, "tools/deep/b.txt"), "beta".repeat(70_000));
    await writeFile(path.join(repo, "outside.txt"), "outside");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "init");
  });
  afterEach(async () => { await rm(repo, { force: true, recursive: true }); });

  it("lists the committed tree, index, untracked files and status relative to a subdirectory", async () => {
    const tools = path.join(repo, "tools");
    const { prefix } = await resolveGitLocation(tools);
    expect(prefix).toBe("tools/");
    expect((await listCommittedTree(tools)).map((entry) => [entry.path, entry.type, entry.mode])).toEqual([["a.txt", "blob", 0o100644], ["deep/b.txt", "blob", 0o100644], ["empty", "blob", 0o100644]]);
    expect((await listIndex(tools)).map((entry) => entry.path)).toEqual(["a.txt", "deep/b.txt", "empty"]);
    await writeFile(path.join(tools, "new.txt"), "new");
    await writeFile(path.join(tools, "a.txt"), "changed");
    expect(await readStatus(tools)).toEqual([{ index: " ", path: "tools/a.txt", worktree: "M" }, { index: "?", path: "tools/new.txt", worktree: "?" }]);
    await expect(resolveGitLocation(os.tmpdir())).rejects.toThrow(/git query failed/u);
  });

  it("streams blob contents in order, including empty and multi-chunk blobs", async () => {
    const tools = path.join(repo, "tools"), tree = await listCommittedTree(tools);
    const seen: Array<{ bytes: number; index: number }> = [];
    let ended = 0;
    await streamBlobs(tools, tree.map((entry) => entry.objectId), {
      begin: async (index, size) => { seen.push({ bytes: 0, index }); expect(size).toBe([5, 280_000, 0][index]); },
      data: async (chunk) => { seen.at(-1)!.bytes += chunk.length; },
      end: async () => { ended += 1; }
    });
    expect(seen).toEqual([{ bytes: 5, index: 0 }, { bytes: 280_000, index: 1 }, { bytes: 0, index: 2 }]);
    expect(ended).toBe(3);
  });

  it("reports status against the exact HEAD it compared, with repository-relative paths", async () => {
    const tools = path.join(repo, "tools");
    const head = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    expect(await readStatusAgainstHead(tools)).toEqual({ changed: [], head });
    await writeFile(path.join(tools, "a b.txt"), "spaced");
    await writeFile(path.join(tools, "a.txt"), "changed");
    expect(await readStatusAgainstHead(tools)).toEqual({ changed: ["tools/a.txt", "tools/a b.txt"], head });
    const empty = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-unborn-"));
    try { await git(empty, "init", "-q"); expect((await readStatusAgainstHead(empty)).head).toBe(""); } finally { await rm(empty, { force: true, recursive: true }); }
  });

  it("re-reads when the index changes during a snapshot, and gives up if it never settles", async () => {
    const tools = path.join(repo, "tools"), location = await resolveGitLocation(tools);
    let reads = 0;
    const value = await readStableSnapshot(location, async () => {
      reads += 1;
      if (reads === 1) { await writeFile(path.join(tools, "a.txt"), "staged"); await git(repo, "add", "tools/a.txt"); }
      return reads;
    });
    expect(value).toBe(2);
    let churn = 0;
    await expect(readStableSnapshot(location, async () => {
      churn += 1; await writeFile(path.join(tools, "a.txt"), `churn ${churn}`); await git(repo, "add", "tools/a.txt");
    })).rejects.toThrow(/kept changing/u);
  });

  it("fails closed on a missing object and on a failing consumer", async () => {
    const tools = path.join(repo, "tools"), tree = await listCommittedTree(tools);
    const noop = { begin: async () => undefined, data: async () => undefined, end: async () => undefined };
    await expect(streamBlobs(tools, ["0".repeat(40)], noop)).rejects.toThrow(/not readable/u);
    await expect(streamBlobs(tools, [tree[0]!.objectId], { ...noop, data: async () => { throw new Error("consumer failed"); } })).rejects.toThrow(/consumer failed/u);
  });
});
