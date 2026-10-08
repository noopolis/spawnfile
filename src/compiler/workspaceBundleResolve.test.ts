import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileProject } from "./compileProject.js";
import { computeWorkspaceBundleKey, resolveWorkspaceBundles } from "./workspaceBundleResolve.js";
import type { CompilePlan } from "./types.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });

const agentSpawnfile = (resource: string[]): string => [
  'spawnfile_version: "0.1"', "kind: agent", "name: analyst", "runtime: openclaw",
  "execution:", "  model:", "    primary:", "      provider: anthropic", "      name: claude-sonnet-4-5", "      auth:", "        method: claude-code",
  "workspace:", "  resources:", ...resource.map((line) => `    ${line}`), ""
].join("\n");

const builtResource = ["- id: tools", "  kind: bundle", "  build:", "    files:", "      root: ../tools", "      exclude: [\"**/*.test.mjs\"]", "  mount: ./repos/tools", "  mode: readonly"];

describe("workspace bundle resolution", () => {
  let repo: string, cache: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-resolve-"));
    cache = path.join(repo, ".cache");
    await git(repo, "init", "-q");
    await mkdir(path.join(repo, "tools"), { recursive: true });
    await mkdir(path.join(repo, "org"), { recursive: true });
    await writeFile(path.join(repo, ".gitignore"), ".cache/\nout*/\norg/.spawn/\n");
    await writeFile(path.join(repo, "tools/server.mjs"), "export const ok = true;\n");
    await writeFile(path.join(repo, "tools/server.test.mjs"), "excluded\n");
    await writeFile(path.join(repo, "org/Spawnfile"), agentSpawnfile(builtResource));
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "init");
  });
  afterEach(async () => { await rm(repo, { force: true, recursive: true }); });

  it("keys on every entry, the archive writer and the target platform", () => {
    const input = { entries: [{ identity: "git:abc", mode: 0o644 as const, path: "a" }] };
    const amd64 = computeWorkspaceBundleKey(input, "linux/amd64");
    expect(amd64).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeWorkspaceBundleKey(input, "linux/amd64")).toBe(amd64);
    expect(computeWorkspaceBundleKey(input, "linux/arm64")).not.toBe(amd64);
    expect(computeWorkspaceBundleKey({ entries: [{ ...input.entries[0]!, identity: "git:abd" }] }, "linux/amd64")).not.toBe(amd64);
    expect(computeWorkspaceBundleKey({ entries: [{ ...input.entries[0]!, mode: 0o755 }] }, "linux/amd64")).not.toBe(amd64);
    expect(computeWorkspaceBundleKey({ entries: [{ ...input.entries[0]!, path: "b" }] }, "linux/amd64")).not.toBe(amd64);
  });

  it("builds once per key, reuses the cache, and rebuilds on a platform or input change", async () => {
    const compile = (out: string, extra: Parameters<typeof compileProject>[1] = {}) =>
      compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, containerArchitecture: "amd64", outputDirectory: path.join(repo, out), ...extra });
    const first = await compile("out-1");
    const [bundle] = first.report.workspace_bundles!;
    expect(bundle).toMatchObject({ file_count: 1, id: "tools", identity: "dev", origin: "built", platform: "linux/amd64" });
    const staged = await readFile(path.join(repo, "out-1/container/workspace-bundles", `${bundle!.sha256.slice(7)}.tar`));
    expect(`sha256:${createHash("sha256").update(staged).digest("hex")}`).toBe(bundle!.sha256);
    expect(await readFile(path.join(repo, "out-1/entrypoint.sh"), "utf8")).toContain(bundle!.sha256);
    await run("tar", ["-xf", path.join(repo, "out-1/container/workspace-bundles", `${bundle!.sha256.slice(7)}.tar`)], { cwd: path.join(repo, "out-1") });
    expect(await readFile(path.join(repo, "out-1/server.mjs"), "utf8")).toBe("export const ok = true;\n");

    const second = await compile("out-2", { bundleIdentity: "release" });
    expect(second.report.workspace_bundles![0]).toMatchObject({ cache_key: bundle!.cache_key, identity: "release", sha256: bundle!.sha256 });
    expect((await readdir(cache)).filter((name) => name.endsWith(".tar"))).toHaveLength(1);

    const arm = await compile("out-3", { containerArchitecture: "arm64" });
    expect(arm.report.workspace_bundles![0]!.cache_key).not.toBe(bundle!.cache_key);
    expect(arm.report.workspace_bundles![0]!.sha256).toBe(bundle!.sha256);

    await writeFile(path.join(repo, "tools/server.mjs"), "export const ok = false;\n");
    const edited = await compile("out-4");
    expect(edited.report.workspace_bundles![0]!.sha256).not.toBe(bundle!.sha256);
    await expect(compile("out-5", { bundleIdentity: "release" })).rejects.toThrow(/requires a clean commit/u);
  }, 60_000);

  it("verifies a declared digest on a built bundle and hashes an unpinned prebuilt tar", async () => {
    const wrong = `sha256:${"0".repeat(64)}`;
    await writeFile(path.join(repo, "org/Spawnfile"), agentSpawnfile([...builtResource, `  sha256: ${wrong}`]));
    await expect(compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, containerArchitecture: "amd64", outputDirectory: path.join(repo, "out-a") }))
      .rejects.toThrow(/built to sha256:[a-f0-9]{64}, but it declares/u);

    await run("tar", ["--format=ustar", "-cf", "../prebuilt.tar", "server.mjs"], { cwd: path.join(repo, "tools") });
    const prebuilt = ["- id: tools", "  kind: bundle", "  source: ../prebuilt.tar", "  mount: ./repos/tools", "  mode: readonly"];
    await writeFile(path.join(repo, "org/Spawnfile"), agentSpawnfile(prebuilt));
    const result = await compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, containerArchitecture: "amd64", outputDirectory: path.join(repo, "out-b") });
    const digest = `sha256:${createHash("sha256").update(await readFile(path.join(repo, "prebuilt.tar"))).digest("hex")}`;
    expect(result.report.workspace_bundles).toEqual([{ id: "tools", origin: "prebuilt", sha256: digest }]);
    expect(await readdir(path.join(repo, "out-b/container/workspace-bundles"))).toEqual([`${digest.slice(7)}.tar`]);

    await writeFile(path.join(repo, "org/Spawnfile"), agentSpawnfile([...prebuilt, `  sha256: ${digest}`]));
    const pinned = await compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, containerArchitecture: "amd64", outputDirectory: path.join(repo, "out-c") });
    expect(pinned.report.workspace_bundles).toBeUndefined();
  }, 60_000);

  it("leaves plans without unresolved bundles untouched", async () => {
    const plan = { nodes: [{ kind: "team", value: {} }, { kind: "agent", value: { workspaceResources: [{ kind: "volume" }] } }] } as unknown as CompilePlan;
    await expect(resolveWorkspaceBundles(plan, { cacheDirectory: cache })).resolves.toMatchObject({ built: 0, report: [], reused: 0 });
  });
});
