import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, it } from "vitest";
import { loadTrainingProject } from "../plan/load.js";
import { resolveTrainingPlan } from "../plan/resolve.js";
import { createTrainingContext } from "../context.js";
import { lowerTrainingExecution, mapTrainingExecution } from "../execution.js";
import { agentManifest, dataFiles, training } from "../plan/fixtures.test-helper.js";
import { preparationFixture, imageDocker, sha } from "./fixtures.test-helper.js";
import { prepareTraining } from "./prepare.js";
import { planTrainingImage } from "./image.js";
import { addTrainingAssetsInput, TRAINING_ASSETS_DESTINATION } from "./assets.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await preparationFixture(); roots.push(f.root);
  await f.put("project/Spawnfile", stringify(agentManifest({ training: { ...training, targets: [{ ...training.targets[0],
    datasets: { ...training.targets[0].datasets, validation: "training/validation.yaml" } }] } })));
  await f.put("project/AGENTS.md", dataFiles["AGENTS.md"]);
  const trainingRoot = path.join(f.root, "private-assets");
  for (const [file, value] of Object.entries(dataFiles).filter(([file]) => file !== "AGENTS.md")) {
    await f.put(`private-assets/${file}`, typeof value === "string" ? value : stringify(value));
  }
  await f.put("private-assets/training/validation.yaml", stringify(dataFiles["training/train.yaml"]));
  await f.put("private-assets/never-stage-secret", "private unlisted sentinel");
  const projectRoot = f.context.project.root;
  const load = async () => {
    const project = await loadTrainingProject(projectRoot, { trainingRoot });
    const plan = resolveTrainingPlan(project, undefined, "test");
    return (await lowerTrainingExecution({ project, plan, trainingConfig: f.configPath,
      args: ["--out", path.join(f.root, "output")] })).execution;
  };
  const execution = await load();
  const context = await createTrainingContext(projectRoot, { packageVersion: "test" });
  const docker = imageDocker();
  const options = { configPath: f.configPath, context, execution, args: execution.args, dryRun: false,
    process: docker.process, timeoutMs: 10000, packageRoot: path.join(f.root, "own"), streams: { stdout() {}, stderr() {} } };
  return { ...f, options, execution, trainingRoot, load, docker };
}

it("stages only the pinned evaluator allowlist and excludes private assets from every image input", async () => {
  const f = await fixture();
  if (!("build" in f.config.image)) throw Error("build expected");
  const imagePlan = await planTrainingImage(f.config.image.build, f.root, [], f.options.packageRoot, f.configPath, f.trainingRoot);
  expect(imagePlan.files.every(file => !file.source.startsWith(f.trainingRoot + path.sep)), "private image exclusion guarantee").toBe(true);
  expect(imagePlan.files.some(file => f.execution.authoring.assets!.files.some(asset => file.sha256 === asset.sha256))).toBe(false);
  const before = await readdir(f.root);
  await prepareTraining({ ...f.options, dryRun: true });
  expect(await readdir(f.root)).toEqual(before); expect(f.docker.calls).toEqual([]);
  const prepared = await prepareTraining({ ...f.options, process: async (args, options) => {
    if (args[2] === "build") {
      const files = await readdir(args.at(-1)!, { recursive: true });
      expect(files.some(file => /private-assets|writing\.grader|train\.yaml|test\.yaml|validation\.yaml|never-stage/u.test(file)), "private image exclusion guarantee").toBe(false);
    }
    return f.docker.process(args, options);
  } });
  if ("dryRun" in prepared) throw Error("actual preparation expected");
  const launch = JSON.parse(await readFile(prepared.configPath, "utf8"));
  const input = launch.inputs.find((entry: { destination: string }) => entry.destination === TRAINING_ASSETS_DESTINATION);
  expect(input.source, "private allowlist staging guarantee").not.toBe(f.trainingRoot);
  expect(await readdir(input.source), "private allowlist staging guarantee").toEqual(["training"]);
  expect((await readdir(path.join(input.source, "training"))).sort()).toEqual(["test.yaml", "train.yaml", "validation.yaml", "writing.grader.yaml"]);
  for (const asset of f.execution.authoring.assets!.files) expect(await readFile(path.join(input.source, asset.path))).toEqual(await readFile(asset.sourcePath));
  expect(prepared.execution!.authoring.assets!.root).toBe(input.source);
  const mapped = mapTrainingExecution(prepared.execution!, file => file.replace(input.source, TRAINING_ASSETS_DESTINATION));
  expect(mapped.authoring.assets!.files.map(file => file.sha256)).toEqual(f.execution.authoring.assets!.files.map(file => file.sha256));
  expect(mapped.authoring.assets!.root).toBe(TRAINING_ASSETS_DESTINATION);
  const resumed = await prepareTraining({ ...f.options, args: [...f.options.args, "--resume"] });
  expect(resumed).toMatchObject({ digest: prepared.digest, image: prepared.image });
  expect(f.docker.calls.filter(args => args[2] === "build")).toHaveLength(1);
  const staged = path.join(input.source, "training/writing.grader.yaml");
  await chmod(staged, 0o600); await writeFile(staged, "tampered");
  await expect(prepareTraining({ ...f.options, args: [...f.options.args, "--resume"] })).rejects.toThrow("snapshot changed");
});

it.each(["train.yaml", "validation.yaml", "test.yaml", "writing.grader.yaml"])("pins %s on fresh runs and binds it to exact resume", async file => {
  const f = await fixture();
  await prepareTraining(f.options);
  const target = path.join(f.trainingRoot, "training", file), previous = await readFile(target);
  await writeFile(target, Buffer.concat([previous, Buffer.from("\n# changed private bytes\n")]));
  f.docker.calls.length = 0;
  const refusal = await prepareTraining({ ...f.options, dryRun: true }).then(() => undefined, (error: Error) => error);
  expect(refusal?.message, "private byte pin guarantee").toContain("changed since plan loading");
  expect(f.docker.calls).toEqual([]);
  const execution = await f.load();
  await expect(prepareTraining({ ...f.options, execution, args: [...execution.args, "--resume"] })).rejects.toThrow("exact resume rejected");
  expect(f.docker.calls.some(args => ["build", "create", "start"].includes(args[2]!))).toBe(false);
});

it.each(["integration", "bridge", "bootstrap", "paideia", "compiler", "claude"])("refuses private assets nested in the %s image source before Docker", async source => {
  const f = await fixture();
  if (!("build" in f.config.image)) throw Error("build expected");
  if (source === "integration") f.config.image.build.integration.source = "private-assets";
  else Object.assign(f.config.image.build, { [source]: "private-assets" });
  await f.save();
  await expect(prepareTraining(f.options), "private image exclusion guarantee").rejects.toThrow("must not enter image inputs");
  expect(f.docker.calls).toEqual([]);
});

it("rejects a broad runtime binding over private assets and reserved input identities", async () => {
  const f = await fixture();
  f.config.inputs.push({ id: "broad-private", source: "private-assets", destination: "/run/training/inputs/broad" }); await f.save();
  await expect(prepareTraining(f.options)).rejects.toThrow("inputs overlap"); expect(f.docker.calls).toEqual([]);
  f.config.inputs.pop();
  f.config.inputs.push({ id: "training-assets", source: "settings", destination: "/run/training/inputs/reserved" }); await f.save();
  await expect(prepareTraining(f.options)).rejects.toThrow("reserved input identity");
});

it("rejects inconsistent, duplicate and escaping allowlist entries", async () => {
  const f = await fixture(), assets = f.execution.authoring.assets!, file = assets.files[0]!;
  for (const files of [[{ ...file, path: "../outside" }], [{ ...file, sourcePath: path.join(f.root, "auth") }], [file, file]]) {
    await expect(addTrainingAssetsInput(f.config, { ...assets, files })).rejects.toThrow("allowlist entry");
  }
});


it("refuses existing evaluator storage as an image input before building", async () => {
  const f = await fixture();
  const prepared = await prepareTraining(f.options);
  if ("dryRun" in prepared || !("build" in f.config.image)) throw Error("actual build expected");
  f.config.image.build.integration.source = path.dirname(prepared.configPath); await f.save();
  f.docker.calls.length = 0;
  await expect(prepareTraining({ ...f.options, dryRun: true })).rejects.toThrow("must not enter image inputs");
  expect(f.docker.calls).toEqual([]);
});


it.each([false, true])("rejects a previous preparation as bootstrap after changing output, private root=%s", async hasPrivateRoot => {
  const f = await fixture();
  const prepared = await prepareTraining(f.options);
  if ("dryRun" in prepared || !("build" in f.config.image)) throw Error("actual build expected");
  const previous = path.dirname(prepared.configPath);
  f.config.image.build.bootstrap = previous;
  f.config.output.source = "later-output"; await f.save(); f.docker.calls.length = 0;
  const execution = hasPrivateRoot ? f.execution : undefined;
  const refusal = await prepareTraining({ ...f.options, execution, args: ["--out", path.join(f.root, "later-output")], dryRun: true })
    .then(() => undefined, (error: Error) => error);
  expect(refusal?.message, "retained evaluator exclusion guarantee").toContain("retained evaluator storage");
  expect(f.docker.calls).toEqual([]);
});

it("rejects private Git overlays before staging the public project", async () => {
  const f = await fixture(), cwd = f.context.project.root, execute = promisify(execFile);
  const git = (args: string[]) => execute("git", args, { cwd });
  await git(["init", "-q"]); await git(["add", "."]);
  const tree = (await git(["write-tree"])).stdout.trim();
  const revision = (await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree, "-m", "fixture"])).stdout.trim();
  const asset = f.execution.authoring.assets!.files.find(file => file.path.endsWith("grader.yaml"))!;
  f.config.inputs[0]!.git = { revision, overlays: [{ source: asset.sourcePath, path: "public-grader.yaml", sha256: asset.sha256 }] };
  await f.save();
  const refusal = await prepareTraining({ ...f.options, dryRun: true }).then(() => undefined, (error: Error) => error);
  expect(refusal?.message, "private overlay exclusion guarantee").toContain("must not enter Git overlays");
  expect(f.docker.calls).toEqual([]);
  await expect(readFile(path.join(cwd, "public-grader.yaml"))).rejects.toThrow();
  // A benign overlay still stages normally; retained evaluator storage is independently refused.
  f.config.inputs[0]!.git!.overlays = [{ source: "grok", path: "public-tool", sha256: sha("native-binary") }]; await f.save();
  const prepared = await prepareTraining(f.options);
  if ("dryRun" in prepared) throw Error("actual preparation expected");
  expect(await readFile(path.join(path.dirname(prepared.configPath), "project/public-tool"), "utf8")).toBe("native-binary");
  const retained = path.join(path.dirname(prepared.configPath), "training-assets", asset.path);
  f.config.inputs[0]!.git!.overlays = [{ source: retained, path: "public-grader.yaml", sha256: asset.sha256 }]; await f.save();
  f.docker.calls.length = 0;
  await expect(prepareTraining({ ...f.options, dryRun: true })).rejects.toThrow("retained evaluator storage");
  expect(f.docker.calls).toEqual([]);
});
