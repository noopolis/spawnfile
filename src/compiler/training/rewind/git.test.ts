import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TeamWorkspaceResource } from "../../../manifest/index.js";
import { BundleTarWriter } from "../../workspaceBundleTar.js";
import { materializeGit, localRepositoryPath, selectCommitAt } from "./git.js";
import { History } from "./history.js";
import { commitTestGit, gitTestRoot, initTestGit, testGit, testMomentRecord } from "./git.test-helper.js";
import type { InputContext } from "./types.js";

const AT = "2026-10-09T08:20:31Z", EARLY = "2026-10-09T08:00:00Z", LATE = "2026-10-09T09:00:00Z";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await gitTestRoot(); roots.push(root);
  const repository = path.join(root, "history/git/agent%3Awriter/archive");
  await initTestGit(repository);
  const past = await commitTestGit(repository, { "readme.txt": "past\n", "package/package.json": "{}\n", "package/secret.txt": "omit\n" }, EARLY);
  const future = await commitTestGit(repository, { "readme.txt": "future\n", "future.txt": "tomorrow\n" }, LATE);
  testGit(repository, ["tag", "future-tag", future]);
  testGit(repository, ["remote", "add", "origin", "https://network-must-not-run.invalid/repo.git"]);
  const resource: TeamWorkspaceResource = { id: "archive", kind: "git", mode: "readonly", mount: "./archive", url: repository };
  const context: InputContext = { at: AT, destination: path.join(root, "output"), history: new History(path.join(root, "history")), record: null,
    input: { section: "resources", declaredBy: "agent:writer", id: "archive", declarationBase: repository, overridden: false, declaration: resource } };
  return { root, repository, past, future, context };
};

describe("git rewind", () => {
  it.each(["git", "bundle"] as const)("refuses future recorded %s commits before materializing", async (kind) => {
    const { repository, past, context } = await fixture();
    context.input.declaration = kind === "git"
      ? { id: "archive", kind, mode: "readonly", mount: "./archive", url: repository }
      : { id: "archive", kind, mode: "readonly", mount: "./archive", build: { files: { root: "package" } } };
    for (const role of ["author", "committer"]) {
      testGit(repository, ["checkout", "--detach", past]);
      testGit(repository, ["commit", "--allow-empty", "-m", "future metadata", `--date=${role === "author" ? LATE : EARLY}`], role === "committer" ? LATE : EARLY);
      const commit = testGit(repository, ["rev-parse", "HEAD"]);
      context.record = { ...testMomentRecord(), resources: [{ id: "archive", kind, commit }] };
      await expect(materializeGit(context)).rejects.toThrow(`Selected commit ${commit} has an author or committer date after ${AT}`);
      await expect(readdir(context.destination)).rejects.toThrow();
    }
  });

  it("records exactly one commit's reachable closure and removes future objects, refs and configuration", async () => {
    const { repository, past, future, context } = await fixture();
    context.record = { ...testMomentRecord(), resources: [{ id: "archive", kind: "git", commit: past }] };
    const result = await materializeGit(context);
    expect(result).toMatchObject({ fidelity: "exact", basis: "record", source: { commit: past } });
    expect(await readFile(path.join(context.destination, "readme.txt"), "utf8")).toBe("past\n");
    const objects = testGit(context.destination, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]).split("\n").sort();
    expect(objects).toEqual(testGit(repository, ["rev-list", "--objects", past]).split("\n").map((line) => line.split(" ")[0]).sort());
    expect(objects).not.toContain(future);
    expect(testGit(context.destination, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/moment");
    expect(testGit(context.destination, ["remote"])).toBe("");
    expect(testGit(context.destination, ["status", "--porcelain"])).toBe("");
    for (const name of ["logs", "FETCH_HEAD", "ORIG_HEAD", "packed-refs"]) await expect(readFile(path.join(context.destination, ".git", name))).rejects.toThrow();
    expect(testGit(repository, ["rev-parse", "HEAD"])).toBe(future);
    expect(testGit(repository, ["tag"])).toBe("future-tag");
  });

  it("can materialize a local full-object pin without history and ignores injected git environment", async () => {
    const { repository, past, context } = await fixture();
    context.history = undefined;
    context.input.declaration = { id: "archive", kind: "git", mode: "readonly", mount: "./archive", url: repository, ref: past.toUpperCase() };
    vi.stubEnv("GIT_DIR", "/does/not/exist");
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree"); vi.stubEnv("GIT_CONFIG_VALUE_0", "/elsewhere");
    expect(await materializeGit(context)).toMatchObject({ fidelity: "exact", basis: "pinned", source: { commit: past } });
    expect(await readFile(path.join(context.destination, "readme.txt"), "utf8")).toBe("past\n");
  });

  it("uses selector-at first-parent fallback and labels its approximation", async () => {
    const { past, context } = await fixture();
    expect(await materializeGit(context)).toMatchObject({ fidelity: "approximate", basis: "selector-at", source: { commit: past }, notes: [expect.stringContaining("dates")] });
  });

  it("does not visit a later merged side branch when selecting the first-parent date", async () => {
    const { repository, past, context } = await fixture();
    testGit(repository, ["checkout", "-b", "side", past]);
    await commitTestGit(repository, { "side.txt": "side\n" }, "2026-10-09T08:19:00Z");
    testGit(repository, ["checkout", "main"]);
    testGit(repository, ["merge", "--no-ff", "--no-edit", "side"], "2026-10-09T10:00:00Z");
    expect((await materializeGit(context)).source.commit).toBe(past);
  });

  it("uses override declaration content and marks it overridden", async () => {
    const { past, repository, context } = await fixture();
    context.history = undefined; context.input.overridden = true;
    context.input.declaration = { id: "archive", kind: "git", mode: "readonly", mount: "./archive", url: repository, ref: past };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "overridden", basis: "override", source: { commit: past } });
  });

  it("refuses absent history, prebuilt bundles without records and network-only pins", async () => {
    const { past, context } = await fixture(); context.history = undefined;
    await expect(materializeGit(context)).rejects.toThrow("unpinned resources require --history");
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", source: "today.tar" };
    await expect(materializeGit(context)).rejects.toThrow("Prebuilt bundle has no recorded commit");
    context.input.declaration = { id: "archive", kind: "git", mode: "readonly", mount: "./archive", url: "https://example.invalid/repo", ref: past };
    await expect(materializeGit(context)).rejects.toThrow("network access is forbidden");
  });

  it("exports files bundle roots and exclusions at their pinned commit", async () => {
    const { past, context } = await fixture();
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", build: { files: { root: "package", ref: past, exclude: ["secret.txt"] } } };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "exact", basis: "pinned", source: { commit: past } });
    expect(await readdir(context.destination)).toEqual(["package.json"]);
  });

  it("refuses future pinned bundle metadata before exporting a plain tree", async () => {
    const { repository, past, future, context } = await fixture();
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", build: { files: { root: "package", ref: future } } };
    await expect(materializeGit(context)).rejects.toThrow("author or committer date after");
    // The author clock is independently checked: an old committer date alone is insufficient.
    testGit(repository, ["checkout", "--detach", past]);
    testGit(repository, ["commit", "--amend", "--no-edit", `--date=${LATE}`], EARLY);
    context.input.declaration.build!.files!.ref = testGit(repository, ["rev-parse", "HEAD"]);
    await expect(materializeGit(context)).rejects.toThrow("author or committer date after");
    await expect(readdir(context.destination)).rejects.toThrow();
  });

  it("exports a prebuilt bundle's recorded git tree instead of today's tar", async () => {
    const { past, context } = await fixture();
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", source: "does-not-exist.tar" };
    context.record = { ...testMomentRecord(), resources: [{ id: "archive", kind: "bundle", commit: past }] };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "exact", basis: "record" });
    expect(await readFile(path.join(context.destination, "readme.txt"), "utf8")).toBe("past\n");
    await expect(readFile(path.join(context.destination, ".git"))).rejects.toThrow();
  });

  it("defers dependency and generated recipes while keeping all declared historical inputs", async () => {
    const { context } = await fixture();
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", build: { dependencies: { directory: "package", image: `node@sha256:${"0".repeat(64)}` } } };
    expect(await materializeGit(context)).toMatchObject({ build: "deferred", fidelity: "approximate" });
    expect(await readdir(context.destination)).toEqual(["package.json", "secret.txt"]);
    await rm(context.destination, { recursive: true });
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", build: { generated: {
      command: ["never-run"], cwd: ".", inputs: [{ root: ".", exclude: ["package/secret.txt"] }, { root: "package" }]
    } } };
    expect(await materializeGit(context)).toMatchObject({ build: "deferred" });
    expect(await readFile(path.join(context.destination, "package/secret.txt"), "utf8")).toBe("omit\n");
    expect(await readFile(path.join(context.destination, "readme.txt"), "utf8")).toBe("past\n");
  });

  it("refuses generated inputs spanning repositories instead of substituting the wrong tree", async () => {
    const { root, context } = await fixture(), other = path.join(root, "other");
    await initTestGit(other); await commitTestGit(other, { "other.txt": "other repository\n" }, EARLY);
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", build: { generated: {
      command: ["never-run"], inputs: [{ root: "." }, { root: other }]
    } } };
    await expect(materializeGit(context)).rejects.toThrow("multiple git repositories");
  });

  it("recreates bundle symlinks and applies declared exclusions", async () => {
    const { repository, context } = await fixture();
    await symlink("package.json", path.join(repository, "package/link"));
    const ref = await commitTestGit(repository, {}, "2026-10-09T08:10:00Z");
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", build: { files: { root: "package", ref } } };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "exact" });
    expect(await readlink(path.join(context.destination, "link"))).toBe("package.json");
    expect(await readFile(path.join(context.destination, "link"), "utf8")).toBe("{}\n");
    await rm(context.destination, { recursive: true, force: true });
    context.input.declaration.build!.files!.exclude = ["link"];
    expect(await materializeGit(context)).toMatchObject({ fidelity: "exact" });
    expect(await readdir(context.destination)).not.toContain("link");
  });

  it("extracts a validated local prebuilt override", async () => {
    const { root, context } = await fixture(), tar = path.join(root, "override.tar");
    const writer = await BundleTarWriter.create(tar);
    await writer.begin("override.txt", 6, 0o644); await writer.data(Buffer.from("fresh\n")); await writer.end(); await writer.finish();
    context.input.overridden = true;
    context.input.declaration = { id: "archive", kind: "bundle", mode: "readonly", mount: "./archive", source: tar };
    expect(await materializeGit(context)).toMatchObject({ fidelity: "overridden", source: {} });
    expect(await readFile(path.join(context.destination, "override.txt"), "utf8")).toBe("fresh\n");
  });

  it("rejects textual history indirections before following them", async () => {
    const { repository, context } = await fixture();
    await writeFile(path.join(repository, ".git/objects/info/alternates"), "/outside/object-store\n");
    await expect(materializeGit(context)).rejects.toThrow("alternates");
    await rm(path.join(repository, ".git/objects/info/alternates"));
    await writeFile(path.join(repository, ".git/config"), "[include]\npath = /outside/config\n");
    await expect(materializeGit(context)).rejects.toThrow("configuration indirection");
    await writeFile(path.join(repository, ".git/commondir"), "/outside/common\n");
    await expect(materializeGit(context)).rejects.toThrow("commondir");
  });

  it("selects date boundaries by instant, rejects unsafe local locations", () => {
    const at = "2026-10-09T10:20:31+02:00";
    expect(selectCommitAt([{ commit: "equal", instant: AT }, { commit: "later", instant: "2026-10-09T08:20:31.001Z" }], at)?.commit).toBe("equal");
    expect(selectCommitAt([{ commit: "later", instant: LATE }], AT)).toBeNull();
    expect(() => localRepositoryPath("git@host:repo", "/tmp")).toThrow("network");
    expect(() => localRepositoryPath("file://remote/tmp/repo", "/tmp")).toThrow("remote file hosts");
  });

  it("supports standalone bare repositories", async () => {
    const { root, repository, past, context } = await fixture();
    const bare = path.join(root, "bare"); await mkdir(bare);
    testGit(root, ["clone", "--quiet", "--bare", repository, bare]);
    await rm(repository, { recursive: true });
    await mkdir(path.dirname(repository), { recursive: true });
    testGit(root, ["clone", "--quiet", "--bare", bare, repository]);
    expect((await materializeGit(context)).source.commit).toBe(past);
  });
});
