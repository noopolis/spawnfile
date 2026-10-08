import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileProject } from "./compileProject.js";
import { createFakeDocker, type FakeDocker } from "./workspaceBundleFakeDocker.test-helper.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });
const IMAGE = `node@sha256:${"d".repeat(64)}`;

// Bakes every source/*.txt into ${output}/<name>.out, uppercased, and appends to runs.log so tests can count executions.
const GENERATOR = [
  "const fs=require('fs'),path=require('path');const out=process.argv[2];",
  "fs.appendFileSync(path.join(__dirname,'..','runs.log'),'run\\n');",
  "for(const name of fs.readdirSync('source').sort()){fs.mkdirSync(path.join(out,'baked'),{recursive:true});",
  "fs.writeFileSync(path.join(out,'baked',name+'.out'),fs.readFileSync(path.join('source',name),'utf8').toUpperCase());}",
  "if(process.env.SPAWNFILE_BUNDLE_OUTPUT!==out)process.exit(9);"
].join("");

const agentSpawnfile = (generated: string[]): string => [
  'spawnfile_version: "0.1"', "kind: agent", "name: analyst", "runtime: openclaw",
  "execution:", "  model:", "    primary:", "      provider: anthropic", "      name: claude-sonnet-4-5", "      auth:", "        method: claude-code",
  "workspace:", "  resources:", "    - id: assets", "      kind: bundle", "      build:", "        generated:", ...generated.map((line) => `          ${line}`),
  "      mount: ./assets", "      mode: readonly", ""
].join("\n");

const hostRecipe = [
  "command: [node, tools/bake.js, \"${output}\"]", "cwd: ../site",
  "inputs:", "  - root: ../site", "    exclude: [runs.log]", "tools:", "  - [cat, ../toolchain.txt]"
];

describe("generated bundles", () => {
  let root: string, docker: FakeDocker;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bundle-generated-"));
    await git(root, "init", "-q");
    await mkdir(path.join(root, "site/source"), { recursive: true });
    await mkdir(path.join(root, "site/tools"), { recursive: true });
    await mkdir(path.join(root, "org"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "cache/\nout-*/\nsite/runs.log\n");
    await writeFile(path.join(root, "site/tools/bake.js"), GENERATOR);
    await writeFile(path.join(root, "site/source/a.txt"), "alpha");
    await writeFile(path.join(root, "toolchain.txt"), "baker 1.0\n");
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(hostRecipe));
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "init");
    docker = await createFakeDocker(root);
  });
  afterEach(async () => { await rm(root, { force: true, recursive: true }); });

  const compile = (out: string, extra: Parameters<typeof compileProject>[1] = {}) => compileProject(path.join(root, "org"), {
    bundleCacheDirectory: path.join(root, "cache"), bundleDockerCommand: docker.command, containerArchitecture: "amd64", outputDirectory: path.join(root, out), ...extra
  });
  const runs = async () => (await readFile(path.join(root, "site/runs.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const extract = async (out: string, digest: string, entry: string) =>
    (await run("tar", ["-xOf", path.join(root, out, "container/workspace-bundles", `${digest.slice(7)}.tar`), entry])).stdout;

  it("runs the command into a private output directory and rebuilds only when inputs, tools or platform change", async () => {
    const first = await compile("out-1");
    const [bundle] = first.report.workspace_bundles!;
    expect(bundle).toMatchObject({ id: "assets", input: "generated", origin: "built", file_count: 1 });
    expect(await extract("out-1", bundle!.sha256, "baked/a.txt.out")).toBe("ALPHA");
    expect(await runs()).toBe(1);

    await compile("out-2", { bundleIdentity: "release" });
    expect(await runs()).toBe(1);
    await writeFile(path.join(root, "site/source/a.txt"), "beta");
    const edited = await compile("out-3");
    expect(await runs()).toBe(2);
    expect(await extract("out-3", edited.report.workspace_bundles![0]!.sha256, "baked/a.txt.out")).toBe("BETA");
    await writeFile(path.join(root, "toolchain.txt"), "baker 2.0\n");
    await compile("out-4");
    expect(await runs()).toBe(3);
    await compile("out-5", { containerArchitecture: "arm64" });
    expect(await runs()).toBe(4);
    await expect(compile("out-6", { bundleIdentity: "release" })).rejects.toThrow(/requires a clean commit/u);
  }, 60_000);

  it("runs in a pinned image on the target platform with the output mounted", async () => {
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile([
      "command: [node, tools/bake.js, \"${output}\"]", "cwd: ../site", `image: "${IMAGE}"`, "inputs:", "  - root: ../site", "    exclude: [runs.log]", "tools:", "  - [node, --version]"
    ]));
    const result = await compile("out-image");
    expect(await extract("out-image", result.report.workspace_bundles![0]!.sha256, "baked/a.txt.out")).toBe("ALPHA");
    const step = (await docker.invocations()).find((args) => args.includes("tools/bake.js"))!;
    expect(step).toEqual(expect.arrayContaining(["--platform", "linux/amd64", "--workdir", "/spawnfile/work", IMAGE, "/spawnfile/output"]));
    expect(step.some((value) => value.endsWith(":/spawnfile/output"))).toBe(true);
  }, 60_000);

  it("never caches output whose inputs or tools changed while the command ran, and keys exact tool bytes", async () => {
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile([
      "command: [sh, -c, \"echo late > source/b.txt; mkdir -p $SPAWNFILE_BUNDLE_OUTPUT/x; echo ok > $SPAWNFILE_BUNDLE_OUTPUT/x/ok\"]", "cwd: ../site", "inputs:", "  - root: ../site"
    ]));
    await expect(compile("out-race")).rejects.toThrow(/changed while it ran/u);
    await rm(path.join(root, "site/source/b.txt"));
    await writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(hostRecipe));
    await compile("out-ws1");
    await writeFile(path.join(root, "toolchain.txt"), "baker 1.0 \n");
    await compile("out-ws2");
    expect(await runs()).toBe(2);
  }, 60_000);

  it("pins a generated bundle by recipe without running its tools", async () => {
    const { pinWorkspaceBundle } = await import("./workspaceBundleResolve.js");
    const resource = {
      build: { generated: { command: ["node", "tools/bake.js", "${output}"], cwd: "../site", inputs: [{ root: "../site" }], tools: [["sh", "-c", "touch tool-ran"]] } },
      id: "assets", kind: "bundle" as const, mode: "readonly" as const, mount: "./assets", sharing: "per_agent" as const,
      scope: { kind: "agent" as const, key: path.join(root, "org/Spawnfile"), name: "analyst" }
    };
    expect(await pinWorkspaceBundle(resource, { architecture: "amd64", cacheDirectory: path.join(root, "cache") })).toMatch(/^bundle-recipe:[a-f0-9]{64}$/u);
    await expect(readFile(path.join(root, "site/tool-ran"))).rejects.toThrow();
    expect(await runs()).toBe(0);
  });

  it("refuses pinned refs, symlinks, empty output, failing commands and timeouts", async () => {
    const write = (lines: string[]) => writeFile(path.join(root, "org/Spawnfile"), agentSpawnfile(lines));
    await write([...hostRecipe.slice(0, 4), "    ref: HEAD"]);
    await expect(compile("out-ref")).rejects.toThrow(/cannot pin a ref/u);
    await write(["command: [ln, -s, /etc/passwd, \"${output}/link\"]", "inputs:", "  - root: ../site"]);
    await expect(compile("out-link")).rejects.toThrow(/symlink/u);
    await write(["command: [\"true\"]", "inputs:", "  - root: ../site"]);
    await expect(compile("out-empty")).rejects.toThrow(/output is empty/u);
    await write(["command: [sh, -c, \"echo broken >&2; exit 4\"]", "inputs:", "  - root: ../site"]);
    await expect(compile("out-fail")).rejects.toThrow(/exited 4: broken/u);
    await write(["command: [sh, -c, \"sleep 30 & wait\"]", "timeout_seconds: 1", "inputs:", "  - root: ../site"]);
    const started = Date.now();
    await expect(compile("out-slow")).rejects.toThrow(/timed out/u);
    expect(Date.now() - started).toBeLessThan(15_000);
    await write(["command: [sh, -c, \"rmdir $SPAWNFILE_BUNDLE_OUTPUT && ln -s /etc $SPAWNFILE_BUNDLE_OUTPUT\"]", "inputs:", "  - root: ../site"]);
    await expect(compile("out-root-link")).rejects.toThrow(/replaced by something other than a directory/u);
    await write(["command: [node, tools/bake.js, \"${output}\"]", "cwd: ../site", `image: "${IMAGE}"`, "inputs:", "  - root: ../org"]);
    await expect(compile("out-outside")).rejects.toThrow(/must live inside cwd/u);
    await write(["command: [sh, -c, \"exit 5\"]", "cwd: ../site", `image: "${IMAGE}"`, "inputs:", "  - root: ../site"]);
    await expect(compile("out-image-fail")).rejects.toThrow(/exited 5/u);
    expect((await docker.invocations()).some((args) => args[0] === "rm" && args[1] === "--force")).toBe(true);
  }, 60_000);
});
