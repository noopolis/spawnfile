import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createTrainingContext } from "../context.js";
import { lowerTrainingExecution } from "../execution.js";
import { loadTrainingProject, resolveTrainingPlan } from "../plan/index.js";
import { agentManifest, dataFiles, training, target, example, trainingProject, writeTrainingFile } from "../plan/fixtures.test-helper.js";

export const activationFixture = async (manifestExtra: Record<string, unknown> = {}) => {
  const root = await trainingProject({});
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  for (const [name, value] of Object.entries({ ...dataFiles, Spawnfile: agentManifest({ runtime: { name: "daimon", options: { engine: "grok" } },
    execution: { model: { primary: { provider: "xai", name: "grok-4.6", auth: { method: "grok" }, reasoning_effort: "high" } } },
    ...manifestExtra, training: {
    ...training, targets: [{ ...target, datasets: { ...target.datasets, validation: "training/validation.yaml" } }], preparation: { hook: "fixture/prepare", history: "history" } } }),
    "training/validation.yaml": { examples: [{ ...example, id: "valid", at: "2026-10-08T00:00:00Z" }] },
    "training/test.yaml": { examples: [{ ...example, id: "held-out", at: "2026-10-07T00:00:00Z" }] },
    "training/container.json": JSON.stringify({
      version: "spawnfile.training-container.v4", slots: 2, dockerContext: "local", image: { ref: `sha256:${"a".repeat(64)}` },
      inputs: [{ id: "project", source: "..", destination: "/run/training/inputs/project" }],
      integration: { settings: { input: "project", path: "training/settings.json" } },
      output: { source: "output", destination: "/run/training/output" }, auth: [],
      broker: { engine: "grok", agentId: "agent:writer", model: "grok-4.6", reasoningEffort: "high", architecture: "arm64",
        limits: { maxRequests: 20, maxTokens: 10000, timeoutMs: 60000 }, realmVolume: "fixture-realm", bootstrap: "dedicated-login" }
    }) })) await writeTrainingFile(projectRoot, name, value);
  await mkdir(path.join(projectRoot, "history"));
  const project = await loadTrainingProject(projectRoot), plan = resolveTrainingPlan(project, "writer", "test");
  const output = path.join(root, "output"); await mkdir(output);
  const execution = (await lowerTrainingExecution({ project, plan, args: ["--out", output] })).execution;
  const context = await createTrainingContext(projectRoot, { packageVersion: "test" });
  const prepareCase = async () => ({ checks: [{ id: "answer", eval: "json-schema", input: "output", schema: { type: "string" } }] });
  return { root, projectRoot, execution, context, prepareCase };
};
