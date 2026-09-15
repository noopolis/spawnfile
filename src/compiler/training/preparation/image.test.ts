import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { planTrainingImage, buildTrainingImage } from "./image.js";
import { preparationFixture, imageDocker, image } from "./fixtures.test-helper.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const f = await preparationFixture(); roots.push(f.root); if (!("build" in f.config.image)) throw Error("build expected");
  return { ...f, build: f.config.image.build, own: path.join(f.root, "own") }; }

it("binds actual runtime bytes, locks, recipe, native parent, platform and entry into image identity", async () => {
  const f = await fixture(); const plan = () => planTrainingImage(f.build, f.root, [], f.own);
  const initial = await plan();
  for (const file of ["paideia/dist/src/cli/main.js", "bridge/paideia_dspy/__init__.py", "bridge/requirements.lock", "integration/entry.ts", "bootstrap/start.ts", "own/dist/cli/index.js", "own/runtime-images/training/Dockerfile"]) {
    const previous = await readFile(path.join(f.root, file)); await f.put(file, "changed");
    expect((await plan()).digest).not.toBe(initial.digest); await writeFile(path.join(f.root, file), previous);
  }
  for (const patch of [{ platform: "linux/amd64" as const }, { nativeImage: `sha256:${"b".repeat(64)}` }, { pythonImage: `sha256:${"c".repeat(64)}` }]) {
    expect((await planTrainingImage({ ...f.build, ...patch }, f.root, [], f.own)).digest).not.toBe(initial.digest);
  }
  await f.put("bridge/__pycache__/cache.pyc"); await f.put("integration/ignored.test.ts"); await f.put("integration/AGENTS.md");
  expect((await plan()).digest).toBe(initial.digest);
});

it("rejects dependency drift, executable pin mismatch, missing required entries and image symlink escapes", async () => {
  const f = await fixture(); const plan = () => planTrainingImage(f.build, f.root, [], f.own);
  f.build.grok.sha256 = image; await expect(plan()).rejects.toThrow("digest mismatch");
  const { sha } = await import("./fixtures.test-helper.js"); f.build.grok.sha256 = sha("native-binary");
  f.build.integration.entry = "missing.ts"; await expect(plan()).rejects.toThrow("missing integration"); f.build.integration.entry = "entry.ts";
  await f.put("claude/package.json", JSON.stringify({ dependencies: { injected: "1" } })); await expect(plan()).rejects.toThrow("manifest/lock mismatch");
  await f.put("claude/package.json", JSON.stringify({ dependencies: {} }));
  await symlink(path.join(f.root, "auth"), path.join(f.root, "integration", "escape.ts")); await expect(plan()).rejects.toThrow("symlinks");
});

it("does not trust a cached tag, empty successful build or changed staged bytes", async () => {
  const f = await fixture(), plan = await planTrainingImage(f.build, f.root, [], f.own), docker = imageDocker();
  const options = { parent: f.root, dockerContext: "local", process: docker.process, timeoutMs: 1000, streams: { stdout() {}, stderr() {} } };
  docker.images.set(`spawnfile-training:${plan.digest.slice(7)}`, "wrong-label");
  expect(await buildTrainingImage(plan, options)).toMatchObject({ cached: false, imageId: image });
  expect(await buildTrainingImage(plan, options)).toMatchObject({ cached: true });
  const before = await readdir(f.root);
  await expect(buildTrainingImage(plan, { ...options, process: async args => ({ code: args[2] === "build" ? 1 : 0, stdout: "invalid JSON", stderr: "" }) })).rejects.toThrow("build failed");
  await expect(buildTrainingImage(plan, { ...options, process: async () => ({ code: 0, stdout: "", stderr: "" }) })).rejects.toThrow("verified immutable");
  expect(await readdir(f.root)).toEqual(before);
  await f.put("integration/entry.ts", "changed after plan");
  await expect(buildTrainingImage(plan, { ...options, process: async () => ({ code: 1, stdout: "", stderr: "" }) })).rejects.toThrow("changed during staging");
});

it("makes privately staged runtime directories traversable for the configured nonroot user", async () => {
  const f = await fixture();
  const packageDirs = ["spawnfile/dist/compiler/training", "paideia/dist/src/cli", "paideia/bridges/dspy", "integration", "bootstrap"];
  for (const directory of packageDirs) {
    const target = path.join(f.root, "runtime", directory);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await chmod(target, 0o700);
    await writeFile(path.join(target, "index.js"), "export const fixture = true;", { mode: 0o600 });
  }
  const dockerfile = await readFile(new URL("../../../../runtime-images/training/Dockerfile", import.meta.url), "utf8");
  const command = dockerfile.match(/chmod -R a\+rX ([^\\\n]+)/u)![1]!.trim().split(/\s+/u);
  execFileSync("chmod", ["-R", "a+rX", ...command.map(target => target.replace("/opt/training", path.join(f.root, "runtime")))]);
  for (const directory of packageDirs) {
    expect((await stat(path.join(f.root, "runtime", directory))).mode & 0o005).toBe(0o005);
    expect((await stat(path.join(f.root, "runtime", directory, "index.js"))).mode & 0o004).toBe(0o004);
  }
});

it("supports integration-owned bootstrap generation without a host snapshot", async () => {
  const f = await fixture(); delete f.build.bootstrap;
  const plan = await planTrainingImage(f.build, f.root, [], f.own), docker = imageDocker();
  expect(plan.files.some(file => file.destination.startsWith("bootstrap/"))).toBe(false);
  await buildTrainingImage(plan, { parent: f.root, dockerContext: "local", timeoutMs: 1000,
    streams: { stdout() {}, stderr() {} }, process: async (args, options) => {
      if (args[2] === "build") expect(await readdir(path.join(args.at(-1)!, "bootstrap"))).toEqual([]);
      return docker.process(args, options);
    } });
});
