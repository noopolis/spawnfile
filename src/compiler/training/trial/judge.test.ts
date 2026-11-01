import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { loadManifest } from "../../../manifest/index.js";
import { compileProject } from "../../compileProject.js";
import { JUDGE_INSTRUCTIONS, writeJudgeAgent } from "./judge.js";
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
  const project = await writeTrialProject(await writeJudgeAgent(spec, path.join(root, "source")), JUDGE_INSTRUCTIONS, path.join(root, "project"));
  const { manifest } = await loadManifest(project);
  expect(manifest).toMatchObject({ kind: "agent", runtime: { name: "daimon", options: { engine } } });
  expect((manifest as { execution?: { model?: { primary?: unknown } } }).execution?.model?.primary).toEqual(primary);
  for (const key of ["skills", "mcp_servers", "surfaces", "schedule", "memory"]) expect(JSON.stringify(manifest)).not.toContain(`"${key}"`);
  const compiled = await compileProject(project, { outputDirectory: path.join(root, "out") });
  expect(Object.values(compiled.report.container!.runtime_instances[0]!.engine_by_node_id ?? {})).toEqual([engine]);
});

it("refuses an effort the engine does not accept and an unknown engine", async () => {
  const root = await scratch();
  await expect(writeJudgeAgent({ engine: "grok", model: "grok-4.6", effort: "xhigh" }, root)).rejects.toThrow("reasoning effort xhigh");
  await expect(writeJudgeAgent({ engine: "nope", model: "m" }, root)).rejects.toThrow("not a Daimon engine");
});
