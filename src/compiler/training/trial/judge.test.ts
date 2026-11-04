import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { loadManifest } from "../../../manifest/index.js";
import { compileProject } from "../../compileProject.js";
import { JUDGE_INSTRUCTIONS, JUDGE_MAX_WAKE_TEXT_BYTES, writeJudgeAgent } from "./judge.js";
import { writeTrialProject } from "./project.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const scratch = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-judge-project-")); roots.push(root);
  return root;
};

it.each([
  ["codex", { engine: "codex", model: "gpt-6-astra", effort: "low" }, { provider: "openai", name: "gpt-6-astra", auth: { method: "codex" }, reasoning_effort: "low" }],
  ["grok", { engine: "grok", model: "grok-4.6", effort: "medium" }, { provider: "xai", name: "grok-4.6", auth: { method: "grok" }, reasoning_effort: "medium" }],
  ["agy", { engine: "agy", model: "ignored" }, undefined]
] as const)("compiles a tool-free %s judge through the trial project path", async (engine, spec, primary) => {
  const root = await scratch();
  const source = await writeJudgeAgent(spec, path.join(root, "source"));
  const project = await writeTrialProject(source, source, JUDGE_INSTRUCTIONS, path.join(root, "project"));
  const manifest = project.manifestOverrides.get(path.resolve(source))!;
  expect(manifest).toMatchObject({ kind: "agent", runtime: { name: "daimon", options: { engine } } });
  expect((manifest as { execution?: { model?: { primary?: unknown } } }).execution?.model?.primary).toEqual(primary);
  for (const key of ["skills", "mcp_servers", "surfaces", "schedule", "memory"]) expect(JSON.stringify(manifest)).not.toContain(`"${key}"`);
  const compiled = await compileProject(project.manifestPath, { manifestOverrides: project.manifestOverrides, outputDirectory: path.join(root, "out") });
  expect(Object.values(compiled.report.container!.runtime_instances[0]!.engine_by_node_id ?? {})).toEqual([engine]);
  // A judge admits a whole reflection prompt; Daimon's default bound would refuse it.
  const config = JSON.parse(await readFile(path.join(root, "out", compiled.report.container!.runtime_instances[0]!.config_path), "utf8"));
  expect(config.host.maxWakeTextBytes).toBe(JUDGE_MAX_WAKE_TEXT_BYTES);
});

it("refuses an effort the engine does not accept and an unknown engine", async () => {
  const root = await scratch();
  await expect(writeJudgeAgent({ engine: "grok", model: "grok-4.6", effort: "xhigh" }, root)).rejects.toThrow("reasoning effort xhigh");
  await expect(writeJudgeAgent({ engine: "nope", model: "m" }, root)).rejects.toThrow("not a Daimon engine");
});
