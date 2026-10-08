import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileProject } from "./compileProject.js";
import { linkBuiltBundle } from "./workspaceBundleArtifacts.js";
import { computeWorkspaceBundleKey, resolveBundleArchitecture, resolveWorkspaceBundles } from "./workspaceBundleResolve.js";
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
    expect(pinned.report.workspace_bundles).toEqual([{ id: "tools", origin: "prebuilt", sha256: digest }]);
  }, 60_000);

  it("never lets a built archive stand in for a pinned prebuilt tar with the same digest", async () => {
    const first = await compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, containerArchitecture: "amd64", outputDirectory: path.join(repo, "out-x") });
    const digest = first.report.workspace_bundles![0]!.sha256;
    const staged = path.join(repo, "out-x/container/workspace-bundles", `${digest.slice(7)}.tar`);
    expect((await stat(staged)).mode & 0o222).toBe(0);
    const pinnedMissing = ["- id: other", "  kind: bundle", "  source: ../missing.tar", `  sha256: ${digest}`, "  mount: ./repos/other", "  mode: readonly"];
    await writeFile(path.join(repo, "org/Spawnfile"), agentSpawnfile([...builtResource, ...pinnedMissing]));
    await expect(compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, containerArchitecture: "amd64", outputDirectory: path.join(repo, "out-y") })).rejects.toThrow(/ENOENT|regular tar/u);
    await writeFile(path.join(repo, "copy.tar"), await readFile(staged));
    await writeFile(path.join(repo, "org/Spawnfile"), agentSpawnfile([...builtResource, ...pinnedMissing.map((line) => line.replace("missing.tar", "copy.tar"))]));
    const both = await compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, containerArchitecture: "amd64", outputDirectory: path.join(repo, "out-z") });
    expect(both.report.workspace_bundles!.map((entry) => entry.id)).toEqual(["other", "tools"]);
  }, 60_000);

  it("ignores git replacement refs so the archive matches the keyed object ids", async () => {
    const first = await compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, containerArchitecture: "amd64", outputDirectory: path.join(repo, "out-r1") });
    const original = (await git(repo, "rev-parse", "HEAD:tools/server.mjs")).stdout.trim();
    await writeFile(path.join(repo, "replacement.txt"), "replaced\n");
    const replacement = (await run("git", ["hash-object", "-w", "replacement.txt"], { cwd: repo })).stdout.trim();
    await rm(path.join(repo, "replacement.txt"));
    await git(repo, "replace", original, replacement);
    await rm(cache, { force: true, recursive: true });
    const second = await compileProject(path.join(repo, "org"), { bundleCacheDirectory: cache, bundleIdentity: "dev", containerArchitecture: "amd64", outputDirectory: path.join(repo, "out-r2") });
    expect(second.report.workspace_bundles![0]!.sha256).toBe(first.report.workspace_bundles![0]!.sha256);
  }, 60_000);

  it("never lets this compile's own output leak into a bundle whose root contains it", async () => {
    const whole = ["- id: project", "  kind: bundle", "  build:", "    files:", "      root: ..", "      exclude: [\".cache\"]", "  mount: ./repos/project", "  mode: readonly"];
    await writeFile(path.join(repo, "org/Spawnfile"), agentSpawnfile([...builtResource, ...whole]));
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "two bundles");
    const options = { bundleCacheDirectory: cache, containerArchitecture: "amd64" as const, outputDirectory: path.join(repo, "build-output") };
    const release = await compileProject(path.join(repo, "org"), { ...options, bundleIdentity: "release" });
    const dev = await compileProject(path.join(repo, "org"), { ...options, clean: false });
    const project = (report: typeof dev.report) => report.workspace_bundles!.find((entry) => entry.id === "project")!;
    expect(project(dev.report).sha256).toBe(project(release.report).sha256);
    const listing = (await run("tar", ["-tf", path.join(repo, "build-output/container/workspace-bundles", `${project(dev.report).sha256.slice(7)}.tar`)])).stdout;
    expect(listing).not.toContain("build-output");
  }, 60_000);

  it("resolves the target architecture and reports a vanished cache archive", async () => {
    expect(resolveBundleArchitecture("arm64")).toBe("arm64");
    const previous = process.env.SPAWNFILE_MOLTNET_TARGET_ARCH;
    try {
      process.env.SPAWNFILE_MOLTNET_TARGET_ARCH = "x86_64"; expect(resolveBundleArchitecture()).toBe("amd64");
      process.env.SPAWNFILE_MOLTNET_TARGET_ARCH = "aarch64"; expect(resolveBundleArchitecture()).toBe("arm64");
      process.env.SPAWNFILE_MOLTNET_TARGET_ARCH = "riscv64"; expect(() => resolveBundleArchitecture()).toThrow(/riscv64/u);
    } finally {
      if (previous === undefined) delete process.env.SPAWNFILE_MOLTNET_TARGET_ARCH; else process.env.SPAWNFILE_MOLTNET_TARGET_ARCH = previous;
    }
    expect(await linkBuiltBundle(path.join(repo, "gone.tar"), path.join(repo, "out-gone"), `sha256:${"1".repeat(64)}`)).toBeUndefined();
  });

  it("leaves plans without unresolved bundles untouched", async () => {
    const plan = { nodes: [{ kind: "team", value: {} }, { kind: "agent", value: { workspaceResources: [{ kind: "volume" }] } }] } as unknown as CompilePlan;
    await expect(resolveWorkspaceBundles(plan, { cacheDirectory: cache, outputDirectory: path.join(repo, "out-none") })).resolves.toMatchObject({ builtCount: 0, report: [], reusedCount: 0 });
  });
});
