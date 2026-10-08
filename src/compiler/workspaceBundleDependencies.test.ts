import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileProject } from "./compileProject.js";
import { assertNpmLockMatchesManifest } from "./workspaceBundleDependencies.js";
import { createFakeDocker, type FakeDocker } from "./workspaceBundleFakeDocker.test-helper.js";

const run = promisify(execFile);
const IMAGE = `node@sha256:${"c".repeat(64)}`;

const agentSpawnfile = (dependencies: string[]): string => [
  'spawnfile_version: "0.1"', "kind: agent", "name: analyst", "runtime: openclaw",
  "execution:", "  model:", "    primary:", "      provider: anthropic", "      name: claude-sonnet-4-5", "      auth:", "        method: claude-code",
  "workspace:", "  resources:", "    - id: deps", "      kind: bundle", "      build:", "        dependencies:", ...dependencies.map((line) => `          ${line}`),
  "      mount: ./deps", "      mode: readonly", ""
].join("\n");

const manifest = { dependencies: { alpha: "^1.0.0" }, devDependencies: { tester: "^2.0.0" }, name: "site" };
const lock = (alpha = "1.0.0") => ({
  lockfileVersion: 3, name: "site",
  packages: {
    "": { dependencies: { alpha: "^1.0.0" }, devDependencies: { tester: "^2.0.0" }, name: "site" },
    "node_modules/alpha": { bin: { alpha: "cli.js" }, version: alpha },
    "node_modules/alpha/node_modules/nested": { version: "0.1.0" },
    "node_modules/tester": { dev: true, version: "2.0.0" }
  }
});

describe("dependency bundles", () => {
  let root: string, docker: FakeDocker;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-deps-"));
    await mkdir(path.join(root, "site"), { recursive: true });
    await mkdir(path.join(root, "org"), { recursive: true });
    await writeFile(path.join(root, "site/package.json"), JSON.stringify(manifest));
    await writeFile(path.join(root, "site/package-lock.json"), JSON.stringify(lock()));
    docker = await createFakeDocker(root);
  });
  afterEach(async () => { await rm(root, { force: true, recursive: true }); });

  const compile = (out: string, extra: Parameters<typeof compileProject>[1] = {}) => compileProject(path.join(root, "org"), {
    bundleCacheDirectory: path.join(root, "cache"), bundleDockerCommand: docker.command, containerArchitecture: "amd64", outputDirectory: path.join(root, out), ...extra
  });
  const installs = async () => (await docker.invocations()).filter((args) => args.includes("ci"));
  const listing = async (out: string, digest: string) =>
    (await run("tar", ["-tf", path.join(root, out, "container/workspace-bundles", `${digest.slice(7)}.tar`)])).stdout.split("\n").filter(Boolean).sort();

  it("installs the lockfile on the target platform in the pinned image, archives node_modules, and reuses the cache by key", async () => {
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(["directory: ../site", `image: "${IMAGE}"`, "check: [node, -e, \"process.exit(0)\"]"]));
    const first = await compile("out-1");
    const [bundle] = first.report.workspace_bundles!;
    expect(bundle).toMatchObject({ id: "deps", input: "dependencies", origin: "built", platform: "linux/amd64" });
    expect(await listing("out-1", bundle!.sha256)).toEqual([
      "node_modules/alpha/cli.js", "node_modules/alpha/node_modules/nested/package.json", "node_modules/alpha/package.json"
    ]);
    const [install] = await installs();
    expect(install).toEqual(expect.arrayContaining(["--platform", "linux/amd64", IMAGE, "npm", "ci", "--omit=dev"]));
    expect((await docker.invocations()).some((args) => args.includes("process.exit(0)"))).toBe(true);

    await compile("out-2");
    expect(await installs()).toHaveLength(1);
    const arm = await compile("out-3", { containerArchitecture: "arm64" });
    expect(await installs()).toHaveLength(2);
    expect(arm.report.workspace_bundles![0]!.cache_key).not.toBe(bundle!.cache_key);

    await writeFile(path.join(root, "site/package-lock.json"), JSON.stringify(lock("1.0.1")));
    const bumped = await compile("out-4");
    expect(await installs()).toHaveLength(3);
    expect(bumped.report.workspace_bundles![0]!.sha256).not.toBe(bundle!.sha256);
  }, 60_000);

  it("keys the install recipe: dev dependencies and script policy change the build", async () => {
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(["directory: ../site", `image: "${IMAGE}"`, "dev: true", "scripts: false"]));
    const result = await compile("out-dev");
    expect((await installs())[0]).toEqual(expect.arrayContaining(["--include=dev", "--ignore-scripts"]));
    expect(await listing("out-dev", result.report.workspace_bundles![0]!.sha256)).toContain("node_modules/tester/package.json");
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(["directory: ../site", `image: "${IMAGE}"`, "scripts: false"]));
    await compile("out-prod");
    expect(await installs()).toHaveLength(2);
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(["directory: ../site", `image: "${IMAGE}"`]));
    await compile("out-scripts");
    expect(await installs()).toHaveLength(3);
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(["directory: ../site", `image: "node@sha256:${"9".repeat(64)}"`]));
    await compile("out-image");
    expect(await installs()).toHaveLength(4);
  }, 60_000);

  it("refuses unpinned images, stale or old lockfiles, linked packages and failed installs", async () => {
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(["directory: ../site", "image: node:22"]));
    await expect(compile("out-unpinned")).rejects.toThrow(/pinned by @sha256/u);
    const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(() => assertNpmLockMatchesManifest(bytes(manifest), bytes({ ...lock(), lockfileVersion: 1 }), "site")).toThrow(/lockfile v2/u);
    expect(() => assertNpmLockMatchesManifest(bytes({ ...manifest, dependencies: { alpha: "^2.0.0" } }), bytes(lock()), "site")).toThrow(/differs/u);
    expect(() => assertNpmLockMatchesManifest(bytes(manifest), bytes({ ...lock(), packages: { ...lock().packages, "node_modules/local": { link: true } } }), "site")).toThrow(/linked/u);
    expect(() => assertNpmLockMatchesManifest(Buffer.from("{"), bytes(lock()), "site")).toThrow(/not valid JSON/u);
    await rm(path.join(root, "site/package-lock.json"));
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(["directory: ../site", `image: "${IMAGE}"`]));
    await expect(compile("out-nolock")).rejects.toThrow(/package-lock\.json/u);
    await writeFile(path.join(root, "site/package-lock.json"), JSON.stringify(lock()));
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(["directory: ../site", `image: "${IMAGE}"`, "check: [sh, -c, \"exit 3\"]"]));
    await expect(compile("out-check")).rejects.toThrow(/Dependency check .* exited 3/u);
    expect(await readFile(path.join(root, "site/package.json"), "utf8")).toBe(JSON.stringify(manifest));
  }, 60_000);
});
