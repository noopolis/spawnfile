import { readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { planTrainingImage, buildTrainingImage } from "./image.js";
import { preparationFixture, imageDocker, image } from "./fixtures.test-helper.js";
import { TRAINING_EXECUTION_CAPABILITY_LABEL, TRAINING_EXECUTION_VERSION } from "../contract.js";
import { launchTrainingContainer } from "../container/launch.js";
import { prepareTraining } from "./prepare.js";
import type { TrainingExecution } from "../execution.js";

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

it("rejects dependency drift, missing required entries and image symlink escapes", async () => {
  const f = await fixture(); const plan = () => planTrainingImage(f.build, f.root, [], f.own);
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


it("pins an explicitly preserved compiler independently of the current launcher", async () => {
  const f = await fixture();
  const { cp } = await import("node:fs/promises");
  await cp(f.own, path.join(f.root, "old-compiler"), { recursive: true });
  f.build.compiler = "old-compiler";
  const plan = () => planTrainingImage(f.build, f.root, [], f.own);
  const old = await plan();
  const compiler = old.files.find(file => file.destination === "compiler/dist/cli/index.js")!;
  await f.put("own/dist/cli/index.js", "new launcher");
  const changed = await plan();
  expect(changed.digest).not.toBe(old.digest);
  expect(changed.files.find(file => file.destination === compiler.destination)?.sha256).toBe(compiler.sha256);
  await f.put("old-compiler/dist/cli/index.js", "changed compiler");
  expect((await plan()).files.find(file => file.destination === compiler.destination)?.sha256).not.toBe(compiler.sha256);
  await f.put("old-compiler/package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, injected: { resolved: "file:../host" } } }));
  await expect(plan()).rejects.toThrow("unsupported local dependencies");
});

it("binds declared execution capability to recipe identity and clears inherited compatibility", async () => {
  const f = await fixture();
  const legacy = await planTrainingImage(f.build, f.root, [], f.own);
  f.build.integration.execution = TRAINING_EXECUTION_VERSION;
  const declared = await planTrainingImage(f.build, f.root, [], f.own);
  expect(declared.dockerfile, "execution label guarantee").toContain(`LABEL ${TRAINING_EXECUTION_CAPABILITY_LABEL}="${TRAINING_EXECUTION_VERSION}"`);
  expect(legacy.dockerfile, "inherited execution refusal guarantee").toContain(`LABEL ${TRAINING_EXECUTION_CAPABILITY_LABEL}=""`);
  expect(declared.digest, "execution identity guarantee").not.toBe(legacy.digest);
});

it("rejects mismatching capability on both cached and freshly built images", async () => {
  const f = await fixture(); f.build.integration.execution = TRAINING_EXECUTION_VERSION;
  const plan = await planTrainingImage(f.build, f.root, [], f.own), docker = imageDocker();
  const options = { parent: f.root, dockerContext: "local", process: docker.process, timeoutMs: 1000, streams: { stdout() {}, stderr() {} } };
  const tag = `spawnfile-training:${plan.digest.slice(7)}`;
  for (const capability of [null, "", "spawnfile.training-execution.v0"]) {
    docker.images.set(tag, plan.digest); docker.capabilities.set(tag, capability);
    expect((await buildTrainingImage(plan, options)).cached, "execution cache verification guarantee").toBe(false);
  }
  expect((await buildTrainingImage(plan, options)).cached).toBe(true);
  docker.images.clear();
  const failed = await buildTrainingImage(plan, { ...options, process: async (args, opts) => {
    const result = await docker.process(args, opts);
    if (args[2] === "build") docker.capabilities.set(tag, "");
    return result;
  } }).then(() => undefined, (error: Error) => error);
  expect(failed?.message, "execution build verification guarantee").toContain("verified immutable image");
});

it("carries the packaged build declaration through preparation to the authored launch gate", async () => {
  // Stop at create: this checks builder/launcher compatibility, never fabricates a training result.
  for (const declared of [true, false]) {
    const f = await fixture();
    if (declared) f.build.integration.execution = TRAINING_EXECUTION_VERSION;
    await f.save();
    // A compatible native parent must not confer compatibility on a different integration.
    const docker = imageDocker(declared ? null : TRAINING_EXECUTION_VERSION);
    const optimizer = { method: "gepa" as const, model: "fixture", variants: 2, keep: 1, budget: { rounds: 1 } };
    const execution: TrainingExecution = { version: TRAINING_EXECUTION_VERSION, args: f.args, output: path.join(f.root, "output"),
      datasetPins: [], optimizer, authoring: { version: "spawnfile.training-plan.v1", producer: { package: "spawnfile", version: "test" },
        project: { root: f.context.project.root, manifest: f.context.project.manifest },
        agent: { id: f.context.agent.id, name: f.context.agent.name }, optimizer, record: null, graders: [], targets: [] } };
    const options = { configPath: f.configPath, context: f.context, args: f.args, execution, dryRun: false,
      process: docker.process, timeoutMs: 1000, packageRoot: f.own, streams: { stdout() {}, stderr() {} } };
    const prepared = await prepareTraining(options); if ("dryRun" in prepared) throw Error("actual preparation expected");
    let created = false;
    const failure = await launchTrainingContainer({ ...options, ...prepared, process: async (args, opts) => {
      if (args[2] === "create") { created = true; return { code: 1, stdout: "", stderr: "gate reached" }; }
      if (args[2] === "inspect") return { code: 1, stdout: "", stderr: "not created" };
      if (args[2] === "container") return { code: 0, stdout: "", stderr: "" };
      return docker.process(args, opts);
    } }).then(() => undefined, (error: Error) => error);
    expect(created, "packaged execution handoff guarantee").toBe(declared);
    expect(failure?.message).toContain(declared ? "gate reached" : "requires an image implementing --spawnfile-execution");
    expect(docker.calls.filter(args => args[2] === "build")).toHaveLength(1);
  }
});
