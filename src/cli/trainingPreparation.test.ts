import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { imageDocker, image, preparationFixture } from "../compiler/training/preparation/fixtures.test-helper.js";
import type { TrainingDockerProcess } from "../compiler/training/container/process.js";
const state = vi.hoisted(() => ({ run: undefined as TrainingDockerProcess | undefined }));
vi.mock("../compiler/training/container/process.js", () => ({ runTrainingDocker: ((args, options) => state.run!(args, options)) satisfies TrainingDockerProcess }));
import { runCli } from "./runCli.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("runs cold, warm and exact-resume through the actual public command and existing launcher", async () => {
  const f = await preparationFixture(); roots.push(f.root); const docker = imageDocker(); let name = "", output = "", preparation = "";
  const id = "b".repeat(64), calls: string[][] = [];
  state.run = async (args, options) => {
    calls.push([...args]);
    const result = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (args[2] === "create") {
      name = args[args.indexOf("--name") + 1]!;
      output = args.find(value => value.includes("dst=/run/training/output"))!.split(",").find(value => value.startsWith("src="))!.slice(4);
      preparation = args.find(value => value.includes("dst=/run/paideia/preparation.json"))!.split(",").find(value => value.startsWith("src="))!.slice(4);
      return result(id);
    }
    if (args[2] === "start") { await writeFile(path.join(output, "index.json"), "{}"); options.stdout?.('{"status":"completed","index":"/run/training/output/index.json"}'); return result(""); }
    if (args[2] === "inspect") return result(args[4] === "{{json .State}}" ? JSON.stringify({ Running: false, ExitCode: 0 }) : [id, `/${name}`, image, { "com.spawnfile.training.owner": name }].map(value => JSON.stringify(value)).join("\n"));
    if (args[2] === "rm" || args[2] === "container") return result("");
    return docker.process(args, options);
  };
  const errors: string[] = [];
  const args = () => ["train", f.context.project.root, "--training-config", f.configPath, "--train", f.args[1]!, "--out", path.join(f.root, f.config.output.source)];
  const run = (extra: string[] = []) => runCli([...args(), ...extra], { streams: { stdout() {}, stderr: value => errors.push(value) } });
  expect(await run()).toBe(0); expect(errors).toEqual([]);
  expect(JSON.parse(await readFile(preparation, "utf8")).imageId).toBe(image);
  expect(await run(["--resume"])).toBe(0);
  f.config.output.source = "warm"; await f.save(); expect(await run()).toBe(0);
  expect(calls.filter(args => args[2] === "build")).toHaveLength(1);
  expect(calls.filter(args => args[2] === "create")).toHaveLength(3);
});

it("keeps v2 public dry-run free of Docker, auth and preparation writes", async () => {
  const f = await preparationFixture(); roots.push(f.root); f.config.image = { ref: image }; f.config.auth[0]!.source = "missing"; await f.save();
  const command = path.join(f.root, "estimate"); await writeFile(command, '#!/usr/bin/env node\nconsole.log(JSON.stringify({schema:"paideia.training-cost-plan.v1",modelCallsMade:0}));\n'); await chmod(command, 0o755);
  state.run = async () => { throw Error("Dry-run must never call Docker"); };
  const output: string[] = [];
  expect(await runCli(["train", f.context.project.root, "--train", f.args[1]!, "--training-config", f.configPath, "--paideia-command", command, "--dry-run"], {
    streams: { stdout: value => output.push(value), stderr() {} }
  })).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({ modelCallsMade: 0 });
  await expect(readFile(path.join(f.root, "output/index.json"))).rejects.toThrow();
});
