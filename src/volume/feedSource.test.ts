import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { refreshVolumeFeed } from "./feedRefresh.js";
import { digestDirectory, fetchFeedSource, resolveFeedSource, stageFeedSource } from "./feedSource.js";
import { createFeedFixture, type FeedFixture } from "./feedTestKit.js";

let fixture: FeedFixture;
afterEach(() => fixture?.cleanup());

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, "-c", "user.email=feed@example.test", "-c", "user.name=feed", ...args], { encoding: "utf8" }).trim();

const commitFiles = (repo: string, files: Record<string, string>, message: string): string => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

const gitFixture = (paths?: string[]): { commit: string; repo: string } => {
  fixture = createFeedFixture();
  const repo = path.join(fixture.root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  const commit = commitFiles(repo, { "data/one.txt": "one\n", "other/skip.txt": "skip\n", "README.md": "readme\n" }, "first");
  fixture.target.source = { fetch: false, kind: "git", ...(paths ? { paths } : {}), ref: "main", repo };
  return { commit, repo };
};

describe("git feed sources", () => {
  it("lands the selected paths of a ref and records the commit as provenance", () => {
    const { commit } = gitFixture(["data"]);
    const result = refreshVolumeFeed(fixture.target);
    expect(result.status).toBe("landed");
    expect(readdirSync(path.join(fixture.volume, "current"))).toEqual(["data"]);
    expect(readFileSync(path.join(fixture.volume, "current", "data", "one.txt"), "utf8")).toBe("one\n");
    const identity = JSON.parse(readFileSync(path.join(fixture.volume, ".spawnfile-feed.json"), "utf8"));
    expect(identity.source).toEqual({ commit, kind: "git", paths: ["data"], ref: "main" });
  });

  it("lands nothing for a commit that does not change the fed paths, and swaps when it does", () => {
    const { repo } = gitFixture(["data"]);
    const first = refreshVolumeFeed(fixture.target).revision;
    commitFiles(repo, { "other/skip.txt": "changed\n" }, "unrelated");
    expect(refreshVolumeFeed(fixture.target)).toMatchObject({ revision: first, status: "current" });
    commitFiles(repo, { "data/two.txt": "two\n" }, "data");
    const next = refreshVolumeFeed(fixture.target);
    expect(next.status).toBe("landed");
    expect(next.revision).not.toBe(first);
    expect(readdirSync(path.join(fixture.volume, "current", "data")).sort()).toEqual(["one.txt", "two.txt"]);
  });

  it("lands the whole tree without paths, refuses an unknown ref or a file path, and fetches only when asked", () => {
    const { repo } = gitFixture();
    expect(refreshVolumeFeed(fixture.target).status).toBe("landed");
    expect(readdirSync(path.join(fixture.volume, "current")).sort()).toEqual(["README.md", "data", "other"]);
    expect(() => resolveFeedSource({ fetch: false, kind: "git", ref: "missing", repo })).toThrow(/cannot resolve missing/u);
    expect(() => resolveFeedSource({ fetch: false, kind: "git", paths: ["README.md"], ref: "main", repo })).toThrow(/not a directory/u);
    expect(() => fetchFeedSource({ fetch: true, kind: "git", ref: "main", repo })).toThrow(/could not fetch/u);
    expect(() => fetchFeedSource({ fetch: false, kind: "git", ref: "main", repo })).not.toThrow();
  });

  it("refuses an extraction that produced nothing", () => {
    const { repo } = gitFixture();
    const resolved = resolveFeedSource(fixture.target.source);
    const staging = path.join(fixture.root, "empty-stage");
    mkdirSync(staging);
    const silent = (command: string, args: string[]): Buffer => command === "tar" ? Buffer.alloc(0) : execFileSync(command, args);
    expect(() => stageFeedSource({ fetch: false, kind: "git", ref: "main", repo }, resolved, staging, { exec: silent })).toThrow(/empty tree/u);
  });
});

describe("directory feed sources", () => {
  it("digests content, executable bits and symlink targets, and refuses special files and missing sources", () => {
    fixture = createFeedFixture();
    const base = digestDirectory(fixture.source);
    chmodSync(path.join(fixture.source, "a.txt"), 0o755);
    const executable = digestDirectory(fixture.source);
    expect(executable).not.toBe(base);
    symlinkSync("a.txt", path.join(fixture.source, "link"));
    expect(digestDirectory(fixture.source)).not.toBe(executable);
    expect(() => resolveFeedSource({ directory: path.join(fixture.root, "absent"), kind: "directory" })).toThrow(/does not exist/u);
    expect(() => resolveFeedSource({ directory: path.join(fixture.source, "a.txt"), kind: "directory" })).toThrow(/not a directory/u);
    execFileSync("mkfifo", [path.join(fixture.source, "pipe")]);
    expect(() => digestDirectory(fixture.source)).toThrow(/special file/u);
  });

  it("refuses an empty directory", () => {
    fixture = createFeedFixture();
    const empty = path.join(fixture.root, "empty");
    mkdirSync(empty);
    expect(() => refreshVolumeFeed({ ...fixture.target, source: { directory: empty, kind: "directory" } })).toThrow(/is empty/u);
  });
});
