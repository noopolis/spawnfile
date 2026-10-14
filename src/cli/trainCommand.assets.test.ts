import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TrainingDockerProcess } from "../compiler/training/container/process.js";
import { dockerFixture } from "../compiler/training/container/fixtures.test-helper.js";
import { cleanTrainingProjects, trainingProject, writeTrainingFile, training } from "../compiler/training/plan/fixtures.test-helper.js";
import { executionFixture, executionImage } from "../compiler/training/execution.test-helper.js";
import type { TrainingExecution } from "../compiler/training/execution.js";
import { loadTrainingProject } from "../compiler/training/plan/load.js";
import { resolveTrainingPlan } from "../compiler/training/plan/resolve.js";
const state = vi.hoisted(() => ({ run: undefined as TrainingDockerProcess | undefined }));
vi.mock("../compiler/training/container/process.js", () => ({ runTrainingDocker: ((args, options) => state.run!(args, options)) satisfies TrainingDockerProcess }));
import { assertTrainingImageExcludesAssets } from "../compiler/training/preparation/assets.js";
import { planTrainingImage } from "../compiler/training/preparation/image.js";
import { preparationFixture } from "../compiler/training/preparation/fixtures.test-helper.js";
import { runCli } from "./runCli.js";

const retained: string[] = [];
afterEach(async () => { await cleanTrainingProjects(); await Promise.all(retained.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const wakeSentinel = "PRIVATE_WAKE_RECEIPT_SENTINEL";
async function fixture() {
  const root = await executionFixture();
  const files: Record<string, string> = {};
  for (const file of ["train.yaml", "validation.yaml", "test.yaml", "writing.grader.yaml"]) {
    files[`training/${file}`] = (await readFile(path.join(root, "training", file), "utf8")).replaceAll("@writer report", wakeSentinel);
    await rm(path.join(root, "training", file));
  }
  const trainingRoot = await trainingProject({ ...files, "unlisted-private-file": "unlisted" });
  return { root, trainingRoot };
}

it("uses the explicit root before plan and dry-run loading without forwarding it or creating output", async () => {
  const f = await fixture(), stdout: string[] = [], stderr: string[] = [];
  const streams = { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) };
  expect(await runCli(["train", f.root, "--plan"], { streams })).toBe(2);
  const before = await readdir(f.root);
  const forbidden = vi.fn(async () => { throw Error("unexpected execution"); }); state.run = forbidden;
  for (const mode of ["--plan", "--dry-run"]) {
    expect(await runCli(["train", f.root, "--training-root", f.trainingRoot, mode], {
      streams, handlers: { delegatePaideiaTraining: forbidden, allocateTrainingOutputParent: forbidden }
    })).toBe(0);
    const receipt = JSON.parse(stdout.at(-1)!);
    expect((receipt.authoring ?? receipt).assets.root).toBe(f.trainingRoot);
    expect(receipt.args ?? []).not.toContain("--training-root");
  }
  expect(forbidden).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual(before);
});

it("projects private assets into the evaluator receipt and preserves the binding on resume", async () => {
  const f = await fixture(), stderr: string[] = [], receipts: TrainingExecution[] = [];
  let output = "", privateStagingOutsideProject = false;
  const docker = dockerFixture(async args => {
    if (args[2] === "create") {
      const mounts = args.filter(arg => arg.startsWith("type=bind,"));
      const source = (destination: string) => mounts.find(mount => mount.includes(`dst=${destination}`))!.split(",").find(part => part.startsWith("src="))!.slice(4);
      const receipt: TrainingExecution = JSON.parse(await readFile(source("/run/paideia/execution.json"), "utf8"));
      receipts.push(receipt);
      expect(receipt.authoring.assets!.root).toBe("/run/training/inputs/training-assets");
      expect(receipt.authoring.graders[0]!.sourcePath).toBe("/run/training/inputs/training-assets/training/writing.grader.yaml");
      expect(receipt.authoring.targets[0]!.files[0]!.sourcePath).toBe("/run/training/inputs/project/AGENTS.md");
      expect(args).toContain("/run/training/inputs/training-assets/training/train.yaml");
      expect(JSON.stringify(receipt)).not.toContain(f.trainingRoot);
      expect(mounts.some(mount => mount.includes(`src=${f.trainingRoot},`))).toBe(false);
      const evaluator = source("/run/training/inputs/training-assets");
      privateStagingOutsideProject = !evaluator.startsWith(f.root + path.sep);
      expect(await readdir(evaluator)).toEqual(["training"]);
      const loaded = await loadTrainingProject(source("/run/training/inputs/project"), { trainingRoot: evaluator, agent: receipt.authoring.agent.id });
      const reloaded = resolveTrainingPlan(loaded, receipt.authoring.agent.id, "test");
      expect(reloaded.assets!.files.map(file => file.sha256)).toEqual(receipt.authoring.assets!.files.map(file => file.sha256));
      output = source("/run/training/output");
    }
    if (args[2] === "start") await writeFile(path.join(output, "index.json"), "{}");
    return undefined;
  }); state.run = docker.process;
  const streams = { stdout() {}, stderr: (line: string) => stderr.push(line) };
  const args = ["train", f.root, "--training-root", f.trainingRoot];
  expect(await runCli(args, { streams }), stderr.join("\n")).toBe(0);
  expect(privateStagingOutsideProject, "private staging location guarantee").toBe(true);
  expect(await runCli([...args, "--resume", "--out", output], { streams }), stderr.join("\n")).toBe(0);
  expect(receipts).toHaveLength(2);
  expect(receipts[1]!.authoring.assets).toEqual(receipts[0]!.authoring.assets);
  // The transport fixture does not perform model evaluation; the host must still read its output artifact.
  expect(await readFile(path.join(output, "index.json"), "utf8")).toBe("{}");
});

it("keeps private wake receipts outside the public image tree even when cleanup is unverified", async () => {
  const f = await fixture(), imageFixture = await preparationFixture(); retained.push(imageFixture.root);
  if (!("build" in imageFixture.config.image)) throw Error("build expected");
  const build = { ...imageFixture.config.image.build, bootstrap: f.root };
  let receiptFile = "", evaluatorStore = "", liveImageChecked = false;
  const docker = dockerFixture(async args => {
    if (args[2] === "create") {
      const source = (destination: string) => args.find(arg => arg.startsWith("type=bind,") && arg.includes(`dst=${destination},`))!
        .split(",").find(part => part.startsWith("src="))!.slice(4);
      receiptFile = source("/run/paideia/execution.json");
      evaluatorStore = path.dirname(source("/run/training/inputs/training-assets")); retained.push(evaluatorStore);
      expect(await readFile(receiptFile, "utf8"), "private receipt sentinel guarantee").toContain(wakeSentinel);
      expect((await stat(path.dirname(receiptFile))).mode & 0o777).toBe(0o700);
      expect((await stat(receiptFile)).mode & 0o777).toBe(0o444);
      const plan = await planTrainingImage(build, imageFixture.root, [], path.join(imageFixture.root, "own"));
      for (const file of plan.files) expect((await readFile(file.source)).includes(Buffer.from(wakeSentinel)), "private receipt image exclusion guarantee").toBe(false);
      liveImageChecked = true;
      return { code: 1, stdout: "", stderr: "simulated interruption" };
    }
    if (args[2] === "inspect") return { code: 1, stdout: "", stderr: "not found" };
    if (args[2] === "container") return { code: 0, stdout: "container closure unknown", stderr: "" };
    return undefined;
  }); state.run = docker.process;
  const stderr: string[] = [];
  // Keep this receipt-isolation probe disjoint from the separately reserved default output tree.
  expect(await runCli(["train", f.root, "--training-root", f.trainingRoot, "--out", path.join(imageFixture.root, "output")], {
    streams: { stdout() {}, stderr: line => stderr.push(line) }
  }), "private receipt storage guarantee").toBe(1);
  expect(path.dirname(path.dirname(receiptFile)), "private receipt storage guarantee").toBe(evaluatorStore);
  expect(receiptFile.startsWith(f.root + path.sep), "private receipt storage guarantee").toBe(false);
  expect(liveImageChecked, "live private receipt image check guarantee").toBe(true);
  expect(stderr.at(-1)).toContain("closure is unknown");
  expect(await readFile(receiptFile, "utf8"), "retained private receipt guarantee").toContain(wakeSentinel);
  const plan = await planTrainingImage(build, imageFixture.root, [], path.join(imageFixture.root, "own"));
  for (const file of plan.files) expect((await readFile(file.source)).includes(Buffer.from(wakeSentinel)), "retained receipt image exclusion guarantee").toBe(false);
  await expect(planTrainingImage({ ...build, bootstrap: path.dirname(receiptFile) }, imageFixture.root, [], path.join(imageFixture.root, "own")))
    .rejects.toThrow("retained evaluator storage");
});

it("rejects direct launch bindings when private assets require allowlist staging", async () => {
  const f = await fixture(), stderr: string[] = [];
  await writeTrainingFile(f.root, "launch.json", JSON.stringify({ version: "spawnfile.training-container.v1", dockerContext: "local",
    inputs: [{ source: f.root, destination: "/run/training/inputs/project" },
      { source: f.trainingRoot, destination: "/run/training/inputs/private" }],
    output: { source: path.join(f.trainingRoot, "output"), destination: "/run/training/output" }, auth: [] }));
  const docker = dockerFixture(); state.run = docker.process;
  expect(await runCli(["train", f.root, "--training-root", f.trainingRoot, "--training-config", path.join(f.root, "launch.json"),
    "--training-image", executionImage], { streams: { stdout() {}, stderr: line => stderr.push(line) } })).toBe(2);
  expect(stderr.at(-1)).toContain("require a v2/v4 preparation declaration"); expect(docker.calls).toEqual([]);
});

it("rejects an image recipe containing private assets on the authored CLI dry-run", async () => {
  const f = await fixture(), stderr: string[] = [];
  const declarationPath = path.join(f.root, "training/container.json");
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  declaration.image = { build: { recipe: "daimon-dspy.v1", nativeImage: executionImage, pythonImage: executionImage,
    platform: "linux/arm64", paideia: f.trainingRoot, bridge: f.trainingRoot, claude: f.trainingRoot,
    integration: { source: f.trainingRoot, entry: "entry.ts" } } };
  await writeFile(declarationPath, JSON.stringify(declaration));
  const docker = dockerFixture(); state.run = docker.process;
  expect(await runCli(["train", f.root, "--training-root", f.trainingRoot, "--dry-run"], {
    streams: { stdout() {}, stderr: line => stderr.push(line) }
  })).toBe(1);
  expect(stderr.at(-1)).toContain("must not enter image inputs"); expect(docker.calls).toEqual([]);
});


it.each(["--plan", "--dry-run", "--materialize"])("scopes private CLI reloads for %s to the selected agent", async mode => {
  const f = await fixture(), stdout: string[] = [], stderr: string[] = [];
  const member = { runtime: "daimon", workspace: { docs: { system: "AGENTS.md" } }, training };
  await writeTrainingFile(f.root, "Spawnfile", { spawnfile_version: "0.1", kind: "team", name: "org", mode: "swarm",
    members: [{ ...member, id: "a" }, { ...member, id: "b", training: { ...training,
      graders: { writing: "training/b-grader.yaml" }, targets: [{ ...training.targets[0],
        datasets: { train: "training/b-train.yaml", test: "training/b-test.yaml" } }] } }] });
  const materialize = vi.fn(async () => { throw Error("selected materializer reached"); });
  const args = ["train", f.root, "--training-root", f.trainingRoot, "--agent", "a", mode,
    ...mode === "--materialize" ? ["ice-shooting", "--out", path.join(f.root, "moment")] : []];
  const code = await runCli(args, { streams: { stdout: line => stdout.push(line), stderr: line => stderr.push(line) },
    handlers: { materializeTrainingMoment: materialize } });
  if (mode === "--materialize") {
    expect(stderr.at(-1), "selected CLI reload guarantee").toContain("selected materializer reached");
    expect(materialize).toHaveBeenCalledOnce(); expect(code).toBe(1);
  } else {
    expect(code, "selected CLI reload guarantee").toBe(0);
    const receipt = JSON.parse(stdout.at(-1)!);
    expect((receipt.authoring ?? receipt).agent.id).toBe("agent:a");
    expect((receipt.authoring ?? receipt).assets.files.some((file: { path: string }) => file.path.includes("b-"))).toBe(false);
  }
});


it.each([false, true])("rejects retained evaluator trees on the authored dry-run with private root=%s", async privateRoot => {
  const f = privateRoot ? await fixture() : { root: await executionFixture(), trainingRoot: undefined };
  const declarationPath = path.join(f.root, "training/container.json");
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  const before = await readdir(f.root);
  const forbidden = vi.fn(async () => { throw Error("unexpected execution"); }); state.run = forbidden;
  for (const name of [".spawnfile-training-preparation-0123456789abcdef", ".spawnfile-training-container-AbCdEf"]) {
    for (const nested of [false, true]) {
      const source = nested ? path.join(f.root, "recipe") : path.join(f.root, name);
      await writeTrainingFile(f.root, path.relative(f.root, path.join(source, ...(nested ? [name] : []), "execution.json")), wakeSentinel);
      const build = { recipe: "daimon-dspy.v1" as const, nativeImage: executionImage, pythonImage: executionImage,
        platform: "linux/arm64" as const, paideia: "missing-paideia", bridge: "missing-bridge", claude: "missing-claude",
        integration: { source: "missing-integration", entry: "entry.ts" }, bootstrap: source };
      declaration.image = { build }; await writeFile(declarationPath, JSON.stringify(declaration));
      const stderr: string[] = [];
      expect(await runCli(["train", f.root, ...privateRoot ? ["--training-root", f.trainingRoot!] : [], "--dry-run"], {
        streams: { stdout() {}, stderr: line => stderr.push(line) },
        handlers: { delegatePaideiaTraining: forbidden, allocateTrainingOutputParent: forbidden }
      }), "retained dry-run exclusion guarantee").toBe(1);
      expect(stderr.at(-1), "retained dry-run exclusion guarantee").toContain("retained evaluator storage");
      await expect(assertTrainingImageExcludesAssets(build, path.dirname(declarationPath), f.trainingRoot)).rejects.toThrow("retained evaluator storage");
      await rm(source, { recursive: true });
    }
  }
  expect(forbidden).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual(before);
});
