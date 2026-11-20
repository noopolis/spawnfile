import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

import { runCli } from "../cli/runCli.js";
import { nativeTrainingCapability } from "./nativeTraining.js";
import * as container from "./nativeTrainingContainer.js";
import { getRuntimeAdapter } from "./registry.js";
import type { RuntimeTrainingCapability } from "./trainingTypes.js";

it("writes a portable file for every trial through the project CLI and grades a moved file", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-native-eval-")));
  const out = path.join(root, "out"), graded = path.join(root, "graded");
  const subjects = new Map<string, string>();
  const close = vi.fn(async () => {});
  const boot = vi.spyOn(container, "bootNativeTrainingTrial").mockImplementation(async (_context, _profile, input) => {
    subjects.set(input.trialId, input.instructions);
    return { instance: { configPath: "/native/config", homePath: "/native", workspacePath: "/native/workspace",
      exec: async () => { throw new Error("Unexpected subprocess"); }, readFile: async () => null },
      readOutput: async () => null, syncInputs: async () => {}, close };
  });
  const capability = nativeTrainingCapability("picoclaw", async () => ({
    async run(_instance, turn) {
      expect(turn.text).toBe("Give the answer");
      const answer = subjects.get(turn.trialId)?.trim() === "BASE" ? "Original" : "OK";
      return { text: answer, toolCoverage: { channel: "tools", completeness: "absent", ordering: "none" } };
    }
  }));
  const runtime = getRuntimeAdapter("picoclaw");
  const training = runtime.training as Required<Pick<RuntimeTrainingCapability, "run">>;
  const route = vi.spyOn(training, "run").mockImplementation(capability.run!);
  const errors: string[] = [];
  const streams = { stdout: () => {}, stderr: (line: string) => errors.push(line) };
  const dataset = (records: string[]) => ({
    schema: "spawnfile.training.dataset.v1", id: "case-study",
    checks: [{ id: "answer", eval: "equals", input: "output.text", value: "OK" }],
    records: records.map(id => ({ id, group: id, input: { prompt: "Give the answer" } }))
  });
  try {
    await writeFile(path.join(root, "Spawnfile"), JSON.stringify({ spawnfile_version: "0.1", kind: "agent", name: "writer",
      runtime: "picoclaw", execution: { model: { primary: { provider: "local", name: "fixture",
        auth: { method: "none" }, endpoint: { compatibility: "openai", base_url: "http://127.0.0.1:1234/v1" } } } },
      workspace: { docs: { system: "AGENTS.md" } } }));
    await writeFile(path.join(root, "AGENTS.md"), "BASE\n");
    await writeFile(path.join(root, "replacement.md"), "IMPROVED\n");
    await writeFile(path.join(root, "test.yaml"), JSON.stringify(dataset(["held-out"])));
    const trainPath = path.join(root, "train.yaml");
    await writeFile(trainPath, JSON.stringify({ ...dataset(["first", "second"]), training: {
      models: { unused: { provider: "ollama", model: "unused" } }, comparison: { candidate: { name: "Revised instructions",
        replacements: [{ resource: "AGENTS.md", source: "replacement.md" }] } }, validation_groups: ["second"],
      test: "test.yaml", budget: { max_trials: 6, timeout_ms: 30000 }
    } }));
    const args = ["train", root, "--train", trainPath, "--out", out, "--editable", "AGENTS.md"];
    const code = await runCli(args, { streams });
    expect(code, errors.join("\n")).toBe(0);
    expect(route).toHaveBeenCalledOnce();
    const names = await readdir(path.join(out, "evals"));
    expect(names).toHaveLength(6);
    expect(close).toHaveBeenCalledTimes(names.length);
    expect(new Set(subjects.values())).toEqual(new Set(["BASE\n", "IMPROVED\n"]));
    const original = path.join(out, "evals", names[0]!);
    const bytes = await readFile(original);
    await rm(original);
    expect(await runCli([...args, "--resume"], { streams }), errors.join("\n")).toBe(0);
    expect(await readFile(original)).toEqual(bytes);
    const moved = path.join(root, "sample.eval");
    await writeFile(moved, bytes, { mode: 0o600 });
    await rm(out, { recursive: true });
    await mkdir(graded);
    expect(await runCli(["train", "--regrade", moved, "--out", graded], { streams }), errors.join("\n")).toBe(0);
    expect(JSON.parse(await readFile(path.join(graded, "REGRADE.json"), "utf8"))).toMatchObject({
      schema: "spawnfile.training.rescore.v1", execution: "completed"
    });
    expect(boot).toHaveBeenCalledTimes(names.length);
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});
