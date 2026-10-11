import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFeedSource } from "../../../volume/index.js";
import { materializeFeed } from "./feed.js";
import { materializeGit } from "./git.js";
import { exportFeedGitTree } from "./gitArchive.js";
import { commitTestGit, gitTestRoot, initTestGit, testGit, testMomentRecord } from "./git.test-helper.js";
import { History } from "./history.js";
import type { InputContext } from "./types.js";

const BEFORE = "2026-10-09T07:00:00Z", AT = "2026-10-09T08:20:31Z", AFTER = "2026-10-10T00:00:00Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("raw historical blob extraction", () => {
  it.each(["feed", "bundle"] as const)("preserves literal export-subst and export-ignore bytes in a %s after a new tag", async (kind) => {
    const root = await gitTestRoot(); roots.push(root);
    const relative = kind === "feed" ? "feeds/agent%3Awriter/input/repo" : "git/agent%3Awriter/input";
    const repository = path.join(root, "history", relative);
    await initTestGit(repository);
    const commit = await commitTestGit(repository, {
      ".gitattributes": "refs.txt export-subst\nhidden.txt export-ignore\n",
      "refs.txt": "$Format:%D$\n", "hidden.txt": "raw retained bytes\n"
    }, BEFORE);
    // This ref did not exist at the historical moment; archive expansion would leak it.
    testGit(repository, ["tag", "-a", "created-after-the-wake", "-m", "later tag", commit], AFTER);
    await mkdir(path.join(repository, ".git/info"), { recursive: true });
    await writeFile(path.join(repository, ".git/info/attributes"), "hidden.txt export-ignore\n");
    const context: InputContext = { at: AT, destination: path.join(root, "out"), history: new History(path.join(root, "history")),
      record: { ...testMomentRecord(), resources: [] },
      input: { section: "resources", id: "input", declaredBy: "agent:writer", overridden: false, declarationBase: repository,
        declaration: kind === "feed"
          ? { id: "input", kind: "volume", mode: "mutable", mount: "./input", name: "input", feed: { git: { repo: repository } } }
          : { id: "input", kind: "bundle", mode: "readonly", mount: "./input", build: { files: { root: "." } } } } };
    let output = context.destination;
    if (kind === "feed") {
      const revision = resolveFeedSource({ kind: "git", repo: repository, ref: commit, fetch: false }).revision;
      await writeFile(path.join(repository, "../landings.jsonl"), `${JSON.stringify({ version: "spawnfile.volume-feed-landing.v1", resource: "input", volume: "input", source: { kind: "git", repo: repository }, revision, tree: `trees/${revision}`, commit, ref: "main", switching_at: BEFORE, landed_at: BEFORE })}\n`);
      expect(await materializeFeed(context)).toMatchObject({ fidelity: "exact", source: { revision, commit } });
      output = path.join(output, "current");
    } else expect(await materializeGit(context)).toMatchObject({ fidelity: "approximate", source: { commit } });
    expect(await readFile(path.join(output, "refs.txt"), "utf8")).toBe("$Format:%D$\n");
    expect(await readFile(path.join(output, "hidden.txt"), "utf8")).toBe("raw retained bytes\n");
  });

  it("recreates symlinks and preserves binary blob bytes without conversion", async () => {
    const root = await gitTestRoot(); roots.push(root);
    const repository = path.join(root, "repo"); await initTestGit(repository);
    const bytes = Buffer.from([0, 255, 10, 128]);
    await writeFile(path.join(repository, "binary"), bytes);
    await symlink("binary", path.join(repository, "link"));
    const commit = await commitTestGit(repository, { ".gitattributes": "binary text eol=crlf\n" }, BEFORE);
    const destination = path.join(root, "out");
    await exportFeedGitTree(repository, commit, destination);
    expect(await readFile(path.join(destination, "binary"))).toEqual(bytes);
    expect((await lstat(path.join(destination, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(destination, "link"))).toBe("binary");
  });

  it("refuses gitlinks instead of silently dropping submodule contents", async () => {
    const root = await gitTestRoot(); roots.push(root);
    const repository = path.join(root, "repo"); await initTestGit(repository);
    const parent = await commitTestGit(repository, { "file": "before\n" }, BEFORE);
    testGit(repository, ["update-index", "--add", "--cacheinfo", `160000,${parent},nested`]);
    testGit(repository, ["commit", "--quiet", "-m", "gitlink"], BEFORE);
    await expect(exportFeedGitTree(repository, testGit(repository, ["rev-parse", "HEAD"]), path.join(root, "out")))
      .rejects.toThrow(/nested.*submodules need their own history/u);
  });
});
