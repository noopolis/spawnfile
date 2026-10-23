import { defaultTrainingOutputRoot } from "../compiler/training/output.js";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TrainingDockerProcess } from "../compiler/training/container/process.js";
import { dockerFixture } from "../compiler/training/container/fixtures.test-helper.js";
import { cleanTrainingProjects, optimizer, writeTrainingFile } from "../compiler/training/plan/fixtures.test-helper.js";
import { executionFixture, executionImage } from "../compiler/training/execution.test-helper.js";
import type { TrainingExecution } from "../compiler/training/execution.js";
import { lowerTrainingExecution } from "../compiler/training/execution.js";
const state = vi.hoisted(() => ({ run: undefined as TrainingDockerProcess | undefined }));
vi.mock("../compiler/training/container/process.js", () => ({ runTrainingDocker: ((args, options) => state.run!(args, options)) satisfies TrainingDockerProcess }));
import { runCli } from "./runCli.js";

afterEach(cleanTrainingProjects);
it("prints a complete lowered dry-run without auth, Docker, delegation, context or allocation", async () => {
  const root = await executionFixture(), stdout: string[] = [], stderr: string[] = [];
  const forbidden = vi.fn(async () => { throw Error("dry-run mutation/execution"); }); state.run = forbidden;
  const before = await readdir(root);
  expect(await runCli(["train", root, "--agent", "writer", "--dry-run"], {
    handlers: { runTraining: forbidden, createTrainingContext: forbidden, allocateTrainingOutputParent: forbidden },
    streams: { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }
  }), "dry-run isolation guarantee").toBe(0);
  expect(stderr).toEqual([]); expect(stdout).toHaveLength(1); expect(forbidden).not.toHaveBeenCalled();
  const plan = JSON.parse(stdout[0]!);
  expect(plan).toMatchObject({ version: "spawnfile.training-execution.v1", optimizer,
    authoring: { agent: { id: "agent:writer" } }, container: { declaration: { image: { ref: executionImage } } } });
  expect(plan.args).toContain(path.join(root, "training/train.yaml"));
  expect(await readdir(root)).toEqual(before);
});
it("runs and resumes the no-flag authoring path through preparation and the actual container launcher", async () => {
  const root = await executionFixture(), stdout: string[] = [], stderr: string[] = [];
  let output = "", receipt: TrainingExecution | undefined, receiptMounted = false, consumerHandoff = false;
  const docker = dockerFixture(async (args, options) => {
    if (args[2] === "create") {
      const mount = args.find(arg => arg.endsWith("dst=/run/spawnfile-training/execution.json,readonly"))!;
      receiptMounted = mount !== undefined;
      if (mount) receipt = JSON.parse(await readFile(mount.split(",").find(part => part.startsWith("src="))!.slice(4), "utf8"));
      output = docker.output().host;
      expect(args).toContain("/run/training/inputs/project/training/train.yaml");
      expect(args).toContain("--editable");
      consumerHandoff = args[args.indexOf("--spawnfile-execution") + 1] === "/run/spawnfile-training/execution.json";
    }
    if (args[2] === "start") await writeFile(path.join(docker.output().live, "index.json"), "{}");
    return undefined;
  }); state.run = docker.process;
  const streams = { stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) };
  expect(await runCli(["train", root, "--agent", "writer"], { streams }), stderr.join("\n")).toBe(0);
  expect(receiptMounted, "execution receipt mount guarantee").toBe(true);
  expect(consumerHandoff, "execution consumer handoff guarantee").toBe(true);
  expect(stderr).toEqual([expect.stringMatching(/^Training output uses VM-local volume .+; host checkpoints update at exit\.$/u)]);
  expect(output).toContain(path.join(defaultTrainingOutputRoot(root), "agent%3Awriter"));
  expect(receipt).toMatchObject({ optimizer, output: "/run/training/output", authoring: {
    agent: { id: "agent:writer" }, graders: [{ sourcePath: "/run/training/inputs/project/training/writing.grader.yaml" }],
    targets: [{ datasets: { validation: { sourcePath: "/run/training/inputs/project/training/validation.yaml", examples: [{ id: "validation" }] } } }]
  } });
  expect(JSON.stringify(receipt)).not.toContain(root);
  expect(stdout.at(-1)).toContain('"status":"completed"');
  expect(await runCli(["train", root, "--agent", "writer", "--resume", "--out", output], { streams }), stderr.join("\n")).toBe(0);
  // Exact resume must include optimizer shape, not just argv/model. A changed plan refuses before a new container.
  const changed = optimizer.variants + 1;
  const manifest = await readFile(path.join(root, "Spawnfile"), "utf8");
  await writeFile(path.join(root, "Spawnfile"), manifest.replace(`variants: ${optimizer.variants}`, `variants: ${changed}`));
  expect(await runCli(["train", root, "--resume", "--out", output], { streams })).toBe(1);
  expect(stderr.at(-1)).toContain("exact resume rejected");
  expect(docker.calls.filter(args => args[2] === "create")).toHaveLength(2);
});
it("rejects missing, wrong-version and failed execution capability probes before container creation", async () => {
  const root = await executionFixture();
  for (const probe of [{ code: 0, stdout: "null" }, { code: 0, stdout: '"spawnfile.training-execution.v0"' }, { code: 1, stdout: '"spawnfile.training-execution.v1"' }]) {
    const stderr: string[] = [];
    let output = "";
    const docker = dockerFixture(async args => {
      if (args[2] === "image" && args.at(-1)?.includes("com.spawnfile.training.execution")) return { ...probe, stderr: "" };
      if (args[2] === "create") output = docker.output().host;
      if (args[2] === "start") await writeFile(path.join(docker.output().live, "index.json"), "{}");
      return undefined;
    }); state.run = docker.process;
    expect(await runCli(["train", root], { streams: { stdout() {}, stderr: value => stderr.push(value) } }), "execution compatibility guarantee").toBe(1);
    expect(stderr.at(-1)).toContain("requires an image implementing --spawnfile-execution");
    expect(docker.calls.filter(args => args[2] === "create")).toEqual([]);
  }
});
it("rejects authored dataset bytes that differ from a pinned Git snapshot for every role", async () => {
  const run = promisify(execFile);
  for (const role of ["train", "validation", "test"]) {
    const root = await executionFixture();
    const git = (args: string[]) => run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root });
    await git(["init", "-q"]); await git(["add", "."]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed"]);
    const revision = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const declaration = JSON.parse(await readFile(path.join(root, "training/container.json"), "utf8"));
    delete declaration.inputs[0].include;
    declaration.inputs[0].git = { revision, overlays: [] };
    await writeTrainingFile(root, "training/container.json", JSON.stringify(declaration));
    const dataset = path.join(root, `training/${role}.yaml`);
    await writeFile(dataset, (await readFile(dataset, "utf8")).replace("text:", "text: changed "));
    const docker = dockerFixture(); state.run = docker.process; const stderr: string[] = [];
    expect(await runCli(["train", root], { streams: { stdout() {}, stderr: value => stderr.push(value) } }), "dataset snapshot guarantee").toBe(1);
    expect(stderr.at(-1)).toContain("snapshot differs");
    expect(docker.calls.filter(args => args[2] === "image"), "dataset snapshot guarantee").toEqual([]);
    expect(docker.calls.filter(args => ["build", "create", "start"].includes(args[2]!))).toEqual([]);
  }
});
it("rejects a dataset changed after lowering on a direct launch before any Docker call", async () => {
  const root = await executionFixture(), outside = await executionFixture(), stderr: string[] = [];
  await writeTrainingFile(root, "launch.json", JSON.stringify({ version: "spawnfile.training-container.v1", dockerContext: "local",
    inputs: [{ source: root, destination: "/run/training/inputs/project" }],
    output: { source: path.join(outside, "output"), destination: "/run/training/output" }, auth: [] }));
  const docker = dockerFixture(async args => {
    if (args[2] === "start") await writeFile(path.join(docker.output().live, "index.json"), "{}");
    return undefined;
  }); state.run = docker.process;
  const result = await runCli(["train", root, "--training-config", path.join(root, "launch.json"),
    "--training-image", executionImage, "--out", path.join(outside, "output")], {
    handlers: { lowerTrainingExecution: async options => {
      const lowered = await lowerTrainingExecution(options);
      await writeFile(path.join(root, "training/train.yaml"), (await readFile(path.join(root, "training/train.yaml"), "utf8")) + "\n# changed bytes\n");
      return lowered;
    } }, streams: { stdout() {}, stderr: value => stderr.push(value) }
  });
  expect(result, "direct dataset binding guarantee").toBe(1);
  expect(stderr.at(-1)).toContain("snapshot differs");
  expect(docker.calls).toEqual([]);
});
it("creates fresh direct-launch output with explicit and disjoint defaults", async () => {
  const root = await executionFixture(), outside = await executionFixture(), stderr: string[] = [];
  const config = { version: "spawnfile.training-container.v1", dockerContext: "local",
    inputs: [{ source: root, destination: "/run/training/inputs/project" }],
    output: { source: path.join(outside, "unused"), destination: "/run/training/output" }, auth: [] };
  await writeTrainingFile(root, "launch.json", JSON.stringify(config));
  const args = ["train", root, "--training-config", path.join(root, "launch.json"), "--training-image", executionImage];
  let output = "";
  const docker = dockerFixture(async args => {
    if (args[2] === "create") output = docker.output().host;
    if (args[2] === "start") await writeFile(path.join(docker.output().live, "index.json"), "{}");
    return undefined;
  }); state.run = docker.process;
  const streams = { stdout() {}, stderr: (value: string) => stderr.push(value) };
  expect(await runCli([...args, "--out", path.join(outside, "fresh")], { streams }), "fresh output launch guarantee").toBe(0);
  expect(docker.calls.filter(args => args[2] === "create")).toHaveLength(1);
  docker.calls.length = 0;
  expect(await runCli(args, { streams }), "direct default output guarantee").toBe(0);
  expect(output.startsWith(path.join(defaultTrainingOutputRoot(root), "agent%3Awriter") + path.sep), "direct default output guarantee").toBe(true);
  expect(docker.calls.filter(args => args[2] === "create")).toHaveLength(1);
  docker.calls.length = 0;
  expect(await runCli([...args, "--resume", "--out", path.join(outside, "missing")], { streams })).toBe(1);
  expect(stderr.at(-1)).toContain("ENOENT");
  expect(docker.calls).toEqual([]);
  expect(await readdir(outside)).not.toContain("missing");
});
it("keeps explicit dataset, output, config, image and model overrides on the authored execution path", async () => {
  const root = await executionFixture();
  await writeTrainingFile(root, "chosen.json", await readFile(path.join(root, "training/container.json"), "utf8"));
  const delegate = vi.fn(async () => 0);
  const output = path.join(root, "chosen-output");
  expect(await runCli(["train", root, "--agent", "writer", "--train", path.join(root, "training/test.yaml"),
    "--out", output, "--training-config", path.join(root, "chosen.json"), "--training-image", executionImage, "--optimizer-model", "override"], {
    handlers: { runTraining: delegate }, streams: { stdout() {}, stderr() {} }
  })).toBe(0);
  expect(delegate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ trainingConfig: path.join(root, "chosen.json"), trainingImage: executionImage,
    execution: expect.objectContaining({ output, optimizer: { ...optimizer, model: "override" } }),
    args: expect.arrayContaining(["--train", path.join(root, "training/test.yaml"), "--out", output]) }));
});
