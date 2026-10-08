import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileProject } from "./compileProject.js";
import type { CompilePlan } from "./types.js";
import { resolveWorkspaceGitPins } from "./workspaceGitPins.js";
import { gitPinRefspec, withGitPinEnvironment, withGitPinLock } from "./workspaceGitFetch.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });

const agentSpawnfile = (resource: string[]): string => [
  'spawnfile_version: "0.1"', "kind: agent", "name: reporter", "runtime: openclaw",
  "execution:", "  model:", "    primary:", "      provider: anthropic", "      name: claude-sonnet-4-5", "      auth:", "        method: claude-code",
  "workspace:", "  resources:", ...resource.map((line) => `    ${line}`), ""
].join("\n");

// Shaped like a consumer pinning a private research repo: a dated branch that
// producers keep committing to, mounted read-only into the agent at release time.
const BRANCH = "edition/2026-10-08";
const pinnedResource = (url: string, selector: string, extra: string[] = []): string[] => [
  "- id: private-source", "  kind: git", `  url: ${url}`, `  ${selector}`, "  fetch: build",
  "  mount: ./repos/private-source", "  mode: readonly", ...extra
];

describe("fetch: build git resources", () => {
  let root: string, source: string, cache: string, org: string;
  const compile = (out: string, extra: Parameters<typeof compileProject>[1] = {}) =>
    compileProject(org, { bundleCacheDirectory: path.join(cache, "workspace-bundles"), containerArchitecture: "amd64", outputDirectory: path.join(root, out), ...extra });
  const commitDay = async (body: string): Promise<string> => {
    await writeFile(path.join(source, "2026-10-08/desks/desk-a.index"), body);
    await git(source, "add", ".");
    await git(source, "commit", "-qm", body.trim());
    return (await git(source, "rev-parse", "HEAD")).stdout.trim();
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-git-pin-"));
    source = path.join(root, "private-source");
    cache = path.join(root, "cache");
    org = path.join(root, "org");
    await mkdir(path.join(source, "2026-10-08/desks"), { recursive: true });
    await mkdir(path.join(source, "2026-10-08/stories"), { recursive: true });
    await mkdir(org, { recursive: true });
    await git(source, "init", "-q", "-b", BRANCH);
    await writeFile(path.join(source, "2026-10-08/stories/s1.md"), "# story one\n");
    await writeFile(path.join(source, "README.md"), "private\n");
  });
  afterEach(async () => { await rm(root, { force: true, recursive: true }); });

  it("pins a moving branch to a commit at compile time, mounts it as a read-only bundle and reproduces it from the recorded commit", async () => {
    const first = await commitDay("s1 first\n");
    await writeFile(path.join(org, "Spawnfile"), agentSpawnfile(pinnedResource(`file://${source}`, `branch: ${BRANCH}`)));
    const result = await compile("out-1", { bundleIdentity: "release" });
    const [pin] = result.report.workspace_git_resources!;
    expect(pin).toMatchObject({ auth: "none", commit: first, file_count: 3, id: "private-source", identity: "release", selector: { kind: "branch", value: BRANCH }, url: `file://${source}` });
    expect(result.report.workspace_bundles).toBeUndefined();

    const archive = path.join(root, "out-1/container/workspace-bundles", `${pin!.sha256.slice(7)}.tar`);
    expect(`sha256:${createHash("sha256").update(await readFile(archive)).digest("hex")}`).toBe(pin!.sha256);
    const listing = (await run("tar", ["-tf", archive])).stdout.split("\n").filter(Boolean).sort();
    expect(listing).toEqual(["2026-10-08/desks/desk-a.index", "2026-10-08/stories/s1.md", "README.md"]);
    const entrypoint = await readFile(path.join(root, "out-1/entrypoint.sh"), "utf8");
    expect(entrypoint).toMatch(new RegExp(`prepare_bundle_resource 'private-source' '[^']*/repos/private-source' '[^']*' '[^']*${pin!.sha256.slice(7)}\\.tar' '${pin!.sha256}'`, "u"));
    expect(entrypoint).not.toContain("prepare_git_resource 'private-source'");
    expect(entrypoint).not.toContain(source);
    expect(await readFile(path.join(root, "out-1/Dockerfile"), "utf8")).toContain("COPY container/workspace-bundles/ /opt/spawnfile/workspace-bundles/");

    // The producers keep committing: the next compile follows the branch to its new tip.
    const second = await commitDay("s1 second\n");
    const moved = (await compile("out-2")).report.workspace_git_resources![0]!;
    expect(moved).toMatchObject({ commit: second, identity: "dev" });
    expect(moved.sha256).not.toBe(pin!.sha256);

    // Reproducible: the recorded commit, declared as ref, rebuilds the identical archive after the branch moved.
    await writeFile(path.join(org, "Spawnfile"), agentSpawnfile(pinnedResource(`file://${source}`, `ref: ${first}`)));
    const replay = (await compile("out-3", { bundleIdentity: "release" })).report.workspace_git_resources![0]!;
    expect(replay).toMatchObject({ commit: first, selector: { kind: "ref", value: first }, sha256: pin!.sha256 });
    // Even from a cold archive cache, and with the remote gone: the commit's objects are already cached.
    await rm(path.join(cache, "git-resources/archives"), { force: true, recursive: true });
    await rm(source, { force: true, recursive: true });
    expect((await compile("out-4", { bundleIdentity: "release" })).report.workspace_git_resources![0]!.sha256).toBe(pin!.sha256);
  }, 60_000);

  it("refuses an unresolvable ref instead of mounting stale or empty content", async () => {
    await commitDay("s1\n");
    await writeFile(path.join(org, "Spawnfile"), agentSpawnfile(pinnedResource(`file://${source}`, "branch: edition/2099-01-01")));
    await expect(compile("out-r", { bundleIdentity: "release" })).rejects.toThrow(/branch edition\/2099-01-01 could not be resolved to a commit/u);
    await expect(compile("out-d")).rejects.toThrow(/could not be resolved to a commit/u);
    await writeFile(path.join(org, "Spawnfile"), agentSpawnfile(pinnedResource(`file://${source}`, `ref: ${"a".repeat(40)}`)));
    await expect(compile("out-c", { bundleIdentity: "release" })).rejects.toThrow(/could not be resolved to a commit/u);
  }, 60_000);

  it("authenticates over SSH with a key from an env var that never reaches the output or outlives the fetch", async () => {
    await commitDay("s1\n");
    const bin = path.join(root, "bin"), log = path.join(root, "ssh.log");
    await mkdir(bin);
    // A stand-in ssh: records how it was called and the key it was handed, then serves the repo locally.
    await writeFile(path.join(bin, "ssh"), [
      "#!/bin/sh", `log=${JSON.stringify(log)}`, 'printf "%s\\n" "$*" >> "$log"',
      'key=""; prev=""; for arg in "$@"; do [ "$prev" = "-i" ] && key="$arg"; prev="$arg"; done',
      'echo "keyfile=$key" >> "$log"; ls -l "$key" | cut -c1-10 >> "$log"; cat "$key" >> "$log"',
      'echo "inherited=${SPAWNFILE_TEST_DEPLOY_KEY:-none}" >> "$log"',
      'for last in "$@"; do :; done', 'exec sh -c "$last"', ""
    ].join("\n"));
    await chmod(path.join(bin, "ssh"), 0o755);
    const material = "-----BEGIN OPENSSH PRIVATE KEY-----\nspawnfile-test-deploy-key-material\n-----END OPENSSH PRIVATE KEY-----";
    const previous = { key: process.env.SPAWNFILE_TEST_DEPLOY_KEY, path: process.env.PATH, ssh: process.env.GIT_SSH_COMMAND };
    process.env.SPAWNFILE_TEST_DEPLOY_KEY = material;
    process.env.PATH = `${bin}:${process.env.PATH}`;
    delete process.env.GIT_SSH_COMMAND;
    try {
      await writeFile(path.join(org, "Spawnfile"), agentSpawnfile(pinnedResource(`ssh://git@private.example.invalid${source}`, `branch: ${BRANCH}`, ["  auth:", "    ssh_key_env: SPAWNFILE_TEST_DEPLOY_KEY"])));
      const result = await compile("out-ssh", { bundleIdentity: "release" });
      expect(result.report.workspace_git_resources![0]).toMatchObject({ auth: "ssh_key_env", url: `ssh://git@private.example.invalid${source}` });
      // A failed fetch cleans its key up too.
      await writeFile(path.join(org, "Spawnfile"), agentSpawnfile(pinnedResource(`ssh://git@private.example.invalid${source}`, "branch: missing", ["  auth:", "    ssh_key_env: SPAWNFILE_TEST_DEPLOY_KEY"])));
      await expect(compile("out-ssh-missing")).rejects.toThrow(/could not be resolved/u);
    } finally {
      for (const [name, value] of [["SPAWNFILE_TEST_DEPLOY_KEY", previous.key], ["PATH", previous.path], ["GIT_SSH_COMMAND", previous.ssh]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    const calls = await readFile(log, "utf8");
    expect(calls).toContain("-o IdentitiesOnly=yes -o BatchMode=yes");
    expect(calls).toContain("git@private.example.invalid");
    expect(calls).toContain("spawnfile-test-deploy-key-material");
    expect(calls).toContain("-rw-------");
    expect(calls).toContain("inherited=none");
    const keyFiles = [...calls.matchAll(/keyfile=(\S+)/gu)].map((match) => match[1]!);
    expect(new Set(keyFiles).size).toBe(2);
    for (const keyFile of keyFiles) expect(await stat(path.dirname(keyFile)).catch(() => undefined)).toBeUndefined();
    // grep exits 1 for "no match"; any other failure must not read as clean.
    const scan = await run("grep", ["-rl", "spawnfile-test-deploy-key-material", path.join(root, "out-ssh"), cache]).then(() => "leaked", (error: { code?: number }) => error.code === 1 ? "clean" : `grep failed: ${error.code}`);
    expect(scan).toBe("clean");
  }, 60_000);

  it("passes a declared key file to ssh and refuses a missing one or an unset env", async () => {
    const key = path.join(root, "deploy_key");
    await writeFile(key, "material\n", { mode: 0o600 });
    const seen = await withGitPinEnvironment({ sshKey: key }, async (env) => env.GIT_SSH_COMMAND);
    expect(seen).toBe(`ssh -i '${key}' -o IdentitiesOnly=yes -o BatchMode=yes`);
    await expect(withGitPinEnvironment({ sshKey: path.join(root, "absent") }, async () => "")).rejects.toThrow(/not a readable file/u);
    await expect(withGitPinEnvironment({ sshKeyEnv: "UNSET_KEY" }, async () => "", {})).rejects.toThrow(/UNSET_KEY is not set/u);
    expect((await withGitPinEnvironment(undefined, async (env) => env, { GIT_SSH_COMMAND: "agent" })).GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("serializes concurrent compiles sharing one cache and takes over a dead owner's lock", async () => {
    await commitDay("s1\n");
    await writeFile(path.join(org, "Spawnfile"), agentSpawnfile(pinnedResource(`file://${source}`, `branch: ${BRANCH}`)));
    const results = await Promise.all(["out-p1", "out-p2", "out-p3"].map((out) => compile(out)));
    expect(new Set(results.map((result) => result.report.workspace_git_resources![0]!.sha256)).size).toBe(1);
    const objects = path.join(cache, "git-resources/objects"), [repository] = (await readdir(objects)).filter((name) => name.endsWith(".git"));
    let order: string[] = [];
    await Promise.all([
      withGitPinLock(path.join(objects, repository!), async () => { order.push("a+"); await new Promise((resolve) => setTimeout(resolve, 150)); order.push("a-"); }),
      new Promise((resolve) => setTimeout(resolve, 20)).then(() => withGitPinLock(path.join(objects, repository!), async () => { order.push("b+"); order.push("b-"); }))
    ]);
    expect(order).toEqual(["a+", "a-", "b+", "b-"]);
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => dead.once("close", resolve));
    await mkdir(path.join(objects, `${repository!}.lock`));
    await writeFile(path.join(objects, `${repository!}.lock/owner`), `${dead.pid}\n`);
    order = [];
    await withGitPinLock(path.join(objects, repository!), async () => { order.push("taken"); });
    expect(order).toEqual(["taken"]);
    expect((await compile("out-p4")).report.workspace_git_resources![0]!.sha256).toBe(results[0]!.report.workspace_git_resources![0]!.sha256);
  }, 60_000);

  it("reports every distinct resolution of one resource id, even when two commits archive identically", async () => {
    const first = await commitDay("same\n");
    await git(source, "commit", "-q", "--allow-empty", "-m", "empty");
    await git(source, "branch", "other", first);
    const resource = (branch: string, agent: string) => ({ branch, fetch: "build", id: "private-source", kind: "git", mode: "readonly", mount: "./repos/private-source", scope: { key: path.join(org, agent, "Spawnfile"), kind: "agent", name: agent }, sharing: "per_agent", url: `file://${source}` });
    const plan = { nodes: [["a", BRANCH], ["b", "other"]].map(([agent, branch]) => ({ kind: "agent", value: { workspaceResources: [resource(branch!, agent!)] } })) } as unknown as CompilePlan;
    const { report } = await resolveWorkspaceGitPins(plan, { architecture: "amd64", bundleCacheDirectory: path.join(cache, "workspace-bundles"), outputDirectory: path.join(root, "out-plan") });
    expect(report).toHaveLength(2);
    expect(new Set(report.map((entry) => entry.sha256)).size).toBe(1);
    expect(new Set(report.map((entry) => entry.commit)).size).toBe(2);
  }, 60_000);

  it("maps selectors to remote refs", () => {
    expect(gitPinRefspec({ kind: "branch", value: "main" })).toEqual({ source: "refs/heads/main" });
    expect(gitPinRefspec({ kind: "tag", value: "v1" })).toEqual({ source: "refs/tags/v1" });
    expect(gitPinRefspec({ kind: "ref", value: "refs/pull/1/head" })).toEqual({ source: "refs/pull/1/head" });
    expect(gitPinRefspec({ kind: "ref", value: "b".repeat(40) })).toEqual({ expected: "b".repeat(40), source: "b".repeat(40) });
    expect(gitPinRefspec({ kind: "none", value: "" })).toEqual({ source: "HEAD" });
  });

  it("follows the default branch, honours exclude, and refuses symlinks", async () => {
    await commitDay("s1\n");
    await writeFile(path.join(org, "Spawnfile"), agentSpawnfile(pinnedResource(`file://${source}`, "exclude: [README.md]")));
    const pin = (await compile("out-h")).report.workspace_git_resources![0]!;
    expect(pin).toMatchObject({ file_count: 2, selector: { kind: "default_branch" } });
    // Shallow: a long-lived private repo's history is never downloaded, only the pinned commit's tree.
    const [objects] = (await readdir(path.join(cache, "git-resources/objects"))).filter((name) => name.endsWith(".git"));
    expect((await stat(path.join(cache, "git-resources/objects", objects!, "shallow"))).isFile()).toBe(true);
    await run("ln", ["-s", "README.md", path.join(source, "link")]);
    await git(source, "add", ".");
    await git(source, "commit", "-qm", "link");
    await expect(compile("out-l")).rejects.toThrow(/contains a symlink; exclude it: link/u);
    expect((await readdir(path.join(cache, "git-resources/objects"))).filter((name) => name.endsWith(".git"))).toHaveLength(1);
  }, 60_000);
});
