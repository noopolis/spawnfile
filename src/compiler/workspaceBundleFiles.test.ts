import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateWorkspaceBundleTar } from "./workspaceBundleArtifacts.js";
import {
  compileExcludePatterns,
  resolveBundleRoot,
  resolveCommittedFiles,
  resolveDevFiles,
  resolveReleaseFiles,
  writeBundleFiles
} from "./workspaceBundleFiles.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });

describe("workspace bundle file inputs", () => {
  let repo: string, tools: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-files-"));
    tools = path.join(repo, "tools");
    await git(repo, "init", "-q");
    await mkdir(path.join(tools, "lib"), { recursive: true });
    await mkdir(path.join(tools, "fixtures"), { recursive: true });
    await writeFile(path.join(tools, "server.mjs"), "export const ok = true;\n");
    await writeFile(path.join(tools, "run.sh"), "#!/bin/sh\n");
    await chmod(path.join(tools, "run.sh"), 0o755);
    await writeFile(path.join(tools, "lib/util.mjs"), "export {};\n");
    await writeFile(path.join(tools, "lib/util.test.mjs"), "test\n");
    await writeFile(path.join(tools, "fixtures/big.json"), "{}\n");
    await writeFile(path.join(tools, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(repo, "unrelated.txt"), "not an input\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "init");
  });
  afterEach(async () => { await rm(repo, { force: true, recursive: true }); });

  const exclude = ["fixtures", "**/*.test.mjs"];

  it("matches exclude globs against root-relative paths and their directories", () => {
    const excluded = compileExcludePatterns(["fixtures/", "**/*.test.mjs", "./docs/?.md", "a.b"]);
    expect(excluded("fixtures/deep/x.json")).toBe(true);
    expect(excluded("lib/x.test.mjs")).toBe(true);
    expect(excluded("x.test.mjs")).toBe(true);
    expect(excluded("docs/a.md")).toBe(true);
    expect(excluded("docs/ab.md")).toBe(false);
    expect(excluded("axb")).toBe(false);
    expect(excluded("lib/fixtures.mjs")).toBe(false);
    expect(compileExcludePatterns([])("anything")).toBe(false);
    for (const bad of ["/abs", "../up", "a/../b", "./"]) expect(() => compileExcludePatterns([bad])).toThrow(/relative path glob/u);
  });

  it("takes release identity from the committed tree and builds the tar from git objects", async () => {
    const release = await resolveReleaseFiles(tools, exclude);
    expect(release.entries.map((entry) => [entry.path, entry.mode, entry.identity.slice(0, 4)])).toEqual([
      [".gitignore", 0o644, "git:"], ["lib/util.mjs", 0o644, "git:"], ["run.sh", 0o755, "git:"], ["server.mjs", 0o644, "git:"]
    ]);
    const summary = await writeBundleFiles(release, path.join(repo, "release.tar"));
    const bytes = await readFile(path.join(repo, "release.tar"));
    expect(() => validateWorkspaceBundleTar(bytes)).not.toThrow();
    expect(summary.fileCount).toBe(4);
    // A clean tree yields the same identity and the same bytes in dev mode.
    const dev = await resolveDevFiles(tools, exclude);
    expect(dev.entries).toEqual(release.entries);
    expect((await writeBundleFiles(dev, path.join(repo, "dev.tar"))).sha256).toBe(summary.sha256);
  });

  it("requires a clean commit for release, ignoring only excluded and outside paths", async () => {
    await writeFile(path.join(repo, "unrelated.txt"), "dirty outside the root\n");
    await writeFile(path.join(tools, "fixtures/big.json"), "dirty but excluded\n");
    await mkdir(path.join(tools, "node_modules"), { recursive: true });
    await writeFile(path.join(tools, "node_modules/ignored.js"), "ignored\n");
    await expect(resolveReleaseFiles(tools, exclude)).resolves.toMatchObject({ mode: "release" });
    await writeFile(path.join(tools, "server.mjs"), "export const ok = false;\n");
    await expect(resolveReleaseFiles(tools, exclude)).rejects.toThrow(/requires a clean commit.*server\.mjs/u);
    await git(repo, "add", "tools/server.mjs");
    await expect(resolveReleaseFiles(tools, exclude)).rejects.toThrow(/requires a clean commit/u);
    await git(repo, "commit", "-qm", "edit");
    await writeFile(path.join(tools, "new.mjs"), "untracked\n");
    await expect(resolveReleaseFiles(tools, exclude)).rejects.toThrow(/requires a clean commit.*new\.mjs/u);
  });

  it("counts uncommitted edits, new files and deletions in dev identity", async () => {
    const before = await resolveDevFiles(tools, exclude);
    await writeFile(path.join(tools, "server.mjs"), "export const ok = false;\n");
    await writeFile(path.join(tools, "new.mjs"), "new\n");
    await unlink(path.join(tools, "lib/util.mjs"));
    await mkdir(path.join(tools, "node_modules"), { recursive: true });
    await writeFile(path.join(tools, "node_modules/ignored.js"), "ignored\n");
    const after = await resolveDevFiles(tools, exclude);
    expect(after.entries.map((entry) => entry.path)).toEqual([".gitignore", "new.mjs", "run.sh", "server.mjs"]);
    expect(after.entries.find((entry) => entry.path === "server.mjs")!.identity).toMatch(/^sha256:/u);
    expect(after.entries.find((entry) => entry.path === "server.mjs")!.identity).not.toBe(before.entries.find((entry) => entry.path === "server.mjs")!.identity);
    await writeBundleFiles(after, path.join(repo, "dev.tar"));
    await run("tar", ["-xf", "dev.tar", "server.mjs"], { cwd: repo });
    expect(await readFile(path.join(repo, "server.mjs"), "utf8")).toBe("export const ok = false;\n");
    await writeFile(path.join(tools, "server.mjs"), "changed again\n");
    await expect(writeBundleFiles(after, path.join(repo, "raced.tar"))).rejects.toThrow(/changed while the bundle was built/u);
  });

  it("archives a pinned ref from the object store regardless of the work tree", async () => {
    const pinned = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(tools, "server.mjs"), "dirty\n");
    await writeFile(path.join(tools, "untracked.mjs"), "new\n");
    const input = await resolveCommittedFiles(tools, pinned, exclude);
    expect(input.entries.map((entry) => entry.path)).toEqual([".gitignore", "lib/util.mjs", "run.sh", "server.mjs"]);
    await writeBundleFiles(input, path.join(repo, "pinned.tar"));
    expect((await run("tar", ["-xOf", "pinned.tar", "server.mjs"], { cwd: repo })).stdout).toBe("export const ok = true;\n");
    await expect(resolveCommittedFiles(tools, "no-such-ref", exclude)).rejects.toThrow(/does not name a commit/u);
    await expect(resolveCommittedFiles(tools, "--output=/tmp/x", exclude)).rejects.toThrow(/does not name a commit/u);
  });

  it("refuses symlinks, submodules, nested repositories and non-directory roots unless excluded", async () => {
    await symlink("server.mjs", path.join(tools, "link.mjs"));
    await expect(resolveDevFiles(tools, exclude)).rejects.toThrow(/symlink/u);
    await expect(resolveDevFiles(tools, [...exclude, "link.mjs"])).resolves.toBeDefined();
    await git(repo, "add", "tools/link.mjs");
    await git(repo, "commit", "-qm", "link");
    await expect(resolveReleaseFiles(tools, exclude)).rejects.toThrow(/symlink/u);
    await expect(resolveDevFiles(tools, exclude)).rejects.toThrow(/symlink/u);
    await expect(resolveReleaseFiles(tools, [...exclude, "link.mjs"])).resolves.toBeDefined();
    const nested = path.join(tools, "vendor");
    await mkdir(nested);
    await git(nested, "init", "-q");
    await writeFile(path.join(nested, "x"), "x");
    await git(nested, "add", ".");
    await git(nested, "commit", "-qm", "nested");
    await expect(resolveDevFiles(tools, [...exclude, "link.mjs"])).rejects.toThrow(/nested git repository/u);
    await git(repo, "add", "tools/vendor");
    await git(repo, "commit", "-qm", "gitlink");
    await expect(resolveReleaseFiles(tools, [...exclude, "link.mjs"])).rejects.toThrow(/submodule/u);
    await expect(resolveDevFiles(tools, [...exclude, "link.mjs"])).rejects.toThrow(/submodule/u);
    await expect(resolveBundleRoot(path.join(tools, "server.mjs"))).rejects.toThrow(/real directory/u);
    await expect(resolveBundleRoot(path.join(tools, "missing"))).rejects.toThrow(/does not exist/u);
  });
});
