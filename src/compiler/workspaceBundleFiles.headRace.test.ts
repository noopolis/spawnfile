import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const moved = vi.hoisted(() => ({ head: "" }));
vi.mock("./workspaceBundleGit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspaceBundleGit.js")>();
  return { ...actual, resolveHead: async (directory: string) => moved.head || actual.resolveHead(directory) };
});

import { resolveReleaseFiles } from "./workspaceBundleFiles.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });

describe("release identity under a concurrent commit", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-head-"));
    await git(repo, "init", "-q");
    await mkdir(path.join(repo, "tools"));
    await writeFile(path.join(repo, "tools/a.txt"), "a");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "init");
  });
  afterEach(async () => { moved.head = ""; await rm(repo, { force: true, recursive: true }); });

  it("refuses when HEAD no longer matches the commit status compared against", async () => {
    await expect(resolveReleaseFiles(path.join(repo, "tools"))).resolves.toMatchObject({ mode: "release" });
    moved.head = "f".repeat(40);
    await expect(resolveReleaseFiles(path.join(repo, "tools"))).rejects.toThrow(/HEAD moved/u);
  });
});
