import { dockerFixture } from "../compiler/training/container/fixtures.test-helper.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { imageDocker, image, preparationFixture } from "../compiler/training/preparation/fixtures.test-helper.js";
import type { TrainingDockerProcess } from "../compiler/training/container/process.js";
const state = vi.hoisted(() => ({ run: undefined as TrainingDockerProcess | undefined }));
vi.mock("../compiler/training/container/process.js", () => ({ runTrainingDocker: ((args, options) => state.run!(args, options)) satisfies TrainingDockerProcess }));
import { runCli } from "./runCli.js";

// Public dataset wire fixtures belong to this CLI integration test, not core imports.
const datasetText = (records: { id: string; group: string }[]): string =>
  `schema: paideia.dataset.v1\nid: example\nchecks:\n  - id: correct\n    eval: equals\n    input: output.text\n    value: OK\nrecords:\n${records.map(record => `  - id: ${record.id}\n    group: ${record.group}\n    input:\n      prompt: Reply OK.\n`).join("")}`;

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("runs cold, warm and exact-resume through the actual public command and existing launcher", async () => {
  const f = await preparationFixture(); roots.push(f.root); const docker = imageDocker(); let preparation = "";
  const calls: string[][] = [];
  const launcher = dockerFixture(async args => {
    if (args[2] === "create") preparation = args.find(value => value.includes("dst=/run/paideia/preparation.json"))!.split(",").find(value => value.startsWith("src="))!.slice(4);
    if (args[2] === "start") await writeFile(path.join(launcher.output().live, "index.json"), "{}");
    return undefined;
  });
  state.run = (args, options) => {
    calls.push([...args]);
    return args[2] === "image" || args[2] === "build" ? docker.process(args, options) : launcher.process(args, options);
  };
  const errors: string[] = [];
  const args = () => ["train", f.context.project.root, "--training-config", f.configPath, "--train", f.args[1]!, "--out", path.join(f.root, f.config.output.source)];
  const run = (extra: string[] = []) => runCli([...args(), ...extra], { streams: { stdout() {}, stderr: value => errors.push(value) } });
  expect(await run(), errors.join("\n")).toBe(0); expect(errors).toEqual([expect.stringMatching(/^Training output uses VM-local volume .+; host checkpoints update at exit\.$/u)]);
  expect(JSON.parse(await readFile(preparation, "utf8")).imageId).toBe(image);
  expect(await run(["--resume"])).toBe(0);
  f.config.output.source = "warm"; await f.save(); expect(await run(), errors.join("\n")).toBe(0);
  expect(calls.filter(args => args[2] === "build")).toHaveLength(1);
  expect(calls.filter(args => args[2] === "create")).toHaveLength(3);
// Three whole cold/warm/resume preparations, each sealing and hashing the complete installed distribution:
// it sits just under the default 30s bound on an idle machine and just over it under full-suite load.
}, 180_000);

it("keeps v2 public dry-run free of Docker, auth and preparation writes", async () => {
  const f = await preparationFixture(); roots.push(f.root); f.config.image = { ref: image }; f.config.auth[0]!.source = "missing"; await f.save();
  await f.put("project/Spawnfile", 'spawnfile_version: "0.1"\nkind: agent\nname: author\nruntime: daimon\nworkspace:\n  docs: { system: AGENTS.md }\nexecution:\n  model:\n    primary: { provider: openai, name: gpt-5.5, auth: { method: codex } }\n');
  await f.put("project/AGENTS.md", "Write clearly.\n");
  await f.put("project/train.yaml", datasetText([{ id: "learn", group: "a" }, { id: "validate", group: "b" }]));
  await f.put("project/test.yaml", datasetText([{ id: "sealed", group: "sealed" }]).replace("id: example", "id: sealed"));
  state.run = async () => { throw Error("Dry-run must never call Docker"); };
  const output: string[] = [], errors: string[] = [];
  expect(await runCli(["train", f.context.project.root, "--train", f.args[1]!, "--training-config", f.configPath, "--test", path.join(f.root, "project/test.yaml"), "--editable", "AGENTS.md", "--optimizer-model", "claude-fable-5-1", "--validation-group", "b", "--dry-run"], {
    streams: { stdout: value => output.push(value), stderr: value => errors.push(value) }
  }), errors.join("\n")).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ modelCallsMade: 0 });
  await expect(readFile(path.join(f.root, "output/index.json"))).rejects.toThrow();
});
