import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadTrainingProject, createTrainingPlan } from "./load.js";
import { trainingPlanJsonSchema, trainingPlanSchema } from "./contract.js";
import { agentManifest, cleanTrainingProjects, dataFiles, example, target, training, trainingProject, writeTrainingFile } from "./fixtures.test-helper.js";

afterEach(cleanTrainingProjects);
const options = { packageVersion: "0.1.17" };

describe("training authoring loader", () => {
  it("reads YAML, resolves label outputs without checking existence, and emits only a plan", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    const project = await loadTrainingProject(root);
    expect(project.graders[path.join(root, "training/writing.grader.yaml")].value.labels?.[0].output)
      .toBe(path.join(root, "training/labels/missing.json"));
    const plan = await createTrainingPlan(path.join(root, "Spawnfile"), options);
    expect(trainingPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.graders).toEqual([{ name: "writing", declaredBy: "agent:writer",
      sourcePath: path.join(root, "training/writing.grader.yaml"), path: "training/writing.grader.yaml", questions: 1, labels: 1 }]);
    expect(plan.targets[0].datasets.test.path).toBe("training/test.yaml");
    expect(plan.targets[0].datasets.validation).toBeNull();
    expect(plan.targets[0].datasets.train.examples).toEqual([{ ...example, overrides: [] }]);
    expect(await readdir(root)).toEqual(["AGENTS.md", "Spawnfile", "training"]);
  });

  it.each([
    ["training/train.yaml", "examples: []\nexamples: []\n"],
    ["training/writing.grader.yaml", "questions: []\nquestions: []\n"],
    ["training/train.yaml", { examples: [{ ...example, extra: "no" }] }],
    ["training/writing.grader.yaml", { questions: [{ id: "q", ask: "?", expected: true, extra: "no" }] }]
  ])("rejects duplicate or unknown keys in %s with file and node identity", async (file, value) => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    await writeTrainingFile(root, file as string, value);
    await expect(createTrainingPlan(root, options)).rejects.toThrow(new RegExp(`${file}.*declared by agent:writer`, "u"));
  });

  it("reports missing data files as validation errors", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    await rm(path.join(root, "training/test.yaml"));
    await expect(createTrainingPlan(root, options)).rejects.toMatchObject({ code: "validation_error", message: expect.stringContaining("training/test.yaml") });
    await expect(loadTrainingProject(path.join(root, "missing"))).rejects.toMatchObject({ code: "validation_error" });
  });

  it("preserves valid POSIX relative names containing a colon", async () => {
    const root = await trainingProject({ ...dataFiles, "C:notes.md": "Portable source text\n",
      Spawnfile: agentManifest({ workspace: { docs: { system: "C:notes.md" } },
        training: { ...training, targets: [{ ...target, files: ["C:notes.md"] }] } }) });
    expect((await createTrainingPlan(root, options)).targets[0].files[0].path).toBe("C:notes.md");
  });

  it("keeps the documented plan JSON Schema identical to the exported contract", async () => {
    const doc = await readFile(new URL("../../../../specs/TRAINING.md", import.meta.url), "utf8");
    const schema = doc.match(/<!-- training-plan-schema:start -->\n```json\n([\s\S]*?)\n```/u)?.[1];
    expect(JSON.parse(schema!)).toEqual(trainingPlanJsonSchema);
  });
});
