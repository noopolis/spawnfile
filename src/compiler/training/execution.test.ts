import { defaultTrainingOutputRoot } from "./output.js";
import { mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { allocateTrainingOutputParent, lowerTrainingExecution, mapTrainingExecution, trainingExecutionSchema } from "./execution.js";
import { loadTrainingProject } from "./plan/load.js";
import { resolveTrainingPlan } from "./plan/resolve.js";
import { cleanTrainingProjects, optimizer, writeTrainingFile, teamFiles, trainingProject } from "./plan/fixtures.test-helper.js";
import { executionFixture, executionImage } from "./execution.test-helper.js";

afterEach(cleanTrainingProjects);
const lower = async (root: string, args: string[] = [], extra = {}) => {
  const project = await loadTrainingProject(root);
  return lowerTrainingExecution({ project, plan: resolveTrainingPlan(project, "writer", "test"), args, ...extra });
};
it("lowers authored inputs and exact optimizer controls with a fresh disjoint output, without writes", async () => {
  const root = await executionFixture(), before = await readdir(root);
  const result = await lower(root), next = await lower(root);
  expect(result.trainingConfig).toBe(path.join(root, "training/container.json"));
  expect(result.execution.output.startsWith(path.join(defaultTrainingOutputRoot(root), "agent%3Awriter") + path.sep), "lowered default output guarantee").toBe(true);
  expect(next.execution.output).not.toBe(result.execution.output);
  expect(result.execution.optimizer).toEqual(optimizer);
  expect(result.execution.args, "validation CLI handoff guarantee").toEqual(["--experiment-timeout-ms", "43200000", "--train", path.join(root, "training/train.yaml"), "--validation", path.join(root, "training/validation.yaml"), "--test", path.join(root, "training/test.yaml"),
    "--editable", "AGENTS.md", "--optimizer-model", optimizer.model, "--out", result.execution.output]);
  expect(result.execution.authoring.targets[0]!.datasets.validation).toMatchObject({ path: "training/validation.yaml" });
  expect(result.execution.authoring.graders[0]!.sourcePath).toBe(path.join(root, "training/writing.grader.yaml"));
  expect(result.declaration).toMatchObject({ image: { ref: executionImage }, integration: { settings: { path: "training/settings.json" } }, auth: [] });
  expect(await readdir(root)).toEqual(before);
});
it("keeps all explicit execution flags as overrides without replacing the original authoring provenance", async () => {
  const root = await executionFixture();
  const args = ["--train", "override.yaml", "--test", "held.yaml", "--validation", "validation-override.yaml", "--editable", "OTHER.md", "--optimizer-model", "override-model",
    "--max-proposals", "2", "--experiment-timeout-ms", "60000000", "--trial-timeout-ms", "4000000", "--out", path.join(root, "chosen")];
  const result = await lower(root, args, { trainingConfig: path.join(root, "training/container.json"), trainingImage: executionImage });
  expect(result.execution.args).toEqual(args);
  expect(result.trainingImage).toBe(executionImage);
  expect(result.execution.optimizer).toEqual({ ...optimizer, model: "override-model" });
  expect(result.execution.authoring.optimizer).toEqual(optimizer);
});
it("keeps the legacy experiment override while independently lowering an authored trial deadline", async () => {
  const root = await executionFixture(), project = await loadTrainingProject(root);
  const plan = resolveTrainingPlan(project, "writer", "test");
  plan.deadlines = { experiment_ms: 60_000_000, trial_ms: 5_000_000 };
  const args = ["--timeout-ms", "5000", "--out", path.join(root, "chosen")];
  const lowered = await lowerTrainingExecution({ project, plan, args });
  expect(lowered.execution.args).not.toContain("--experiment-timeout-ms");
  expect(lowered.execution.args).toEqual(expect.arrayContaining(["--timeout-ms", "5000", "--trial-timeout-ms", "5000000"]));
  const override = await lowerTrainingExecution({ project, plan, args: [...args, "--trial-timeout-ms", "2000"] });
  expect(override.execution.args).toEqual(expect.arrayContaining(["--trial-timeout-ms", "2000"]));
  expect(override.execution.args).not.toContain("5000000");
});
it("accepts lowered v4 launch configurations without preparation-only fields and requires their explicit image", async () => {
  const root = await executionFixture();
  const config = { version: "spawnfile.training-container.v4", slots: 1, dockerContext: "local",
    inputs: [{ source: root, destination: "/run/training/inputs/project" }],
    output: { source: path.join(root, "unused"), destination: "/run/training/output" }, auth: [],
    broker: { engine: "grok", realmVolume: "training-test", bootstrap: path.join(root, "auth.json"), declaration: path.join(root, "broker.json") } };
  await writeTrainingFile(root, "launch.json", JSON.stringify(config));
  const result = await lower(root, [], { trainingConfig: path.join(root, "launch.json"), trainingImage: executionImage })
    .catch((error: Error) => ({ error }));
  expect(result, "lowered v4 dispatch guarantee").toMatchObject({ declaration: config });
  await expect(lower(root, [], { trainingConfig: path.join(root, "launch.json") })).rejects.toThrow("requires --training-image");
});
it("maps graders, validation moments, source identities, and execution paths without changing roles or controls", async () => {
  const root = await executionFixture(), { execution } = await lower(root);
  const mapped = mapTrainingExecution(execution, file => file.replace(root, "/run/training/inputs/project"));
  expect(mapped.authoring.project.root).toBe("/run/training/inputs/project");
  expect(mapped.authoring.targets[0]!.datasets.validation, "validation projection guarantee").toEqual({ ...execution.authoring.targets[0]!.datasets.validation,
    sourcePath: "/run/training/inputs/project/training/validation.yaml" });
  expect(mapped.authoring.graders[0]!.sourcePath).toBe("/run/training/inputs/project/training/writing.grader.yaml");
  expect(mapped.authoring.targets[0]!.files[0]!.sourcePath).toBe("/run/training/inputs/project/AGENTS.md");
  expect(mapped.optimizer).toEqual(optimizer);
  expect(trainingExecutionSchema.safeParse({ ...mapped, optimizer: undefined }).success).toBe(false);
});
it("requires explicit output for resume and refuses missing or invalid container declarations", async () => {
  const root = await executionFixture();
  await expect(lower(root, ["--resume"])).rejects.toThrow("--resume requires --out");
  const resumed = await lower(root, ["--resume", "--out", path.join(root, "prior")]);
  expect(resumed.execution.output).toBe(path.join(root, "prior"));
  await rm(path.join(root, "training/container.json"));
  await expect(lower(root)).rejects.toThrow("requires a container declaration");
  await writeTrainingFile(root, "training/container.json", '{"version":"unknown"}');
  await expect(lower(root)).rejects.toThrow();
});
it("falls back to root convention for a referenced agent and carries every target dataset for lowering", async () => {
  const root = await trainingProject(teamFiles());
  await writeTrainingFile(root, "training/container.json", JSON.stringify({
    version: "spawnfile.training-container.v2", dockerContext: "local", image: { ref: executionImage },
    inputs: [{ id: "project", source: "..", destination: "/run/training/inputs/project" }],
    integration: { settings: { input: "project", path: "." } }, output: { source: "output", destination: "/run/training/output" }, auth: []
  }));
  const project = await loadTrainingProject(root), plan = resolveTrainingPlan(project, "a", "test");
  expect((await lowerTrainingExecution({ project, plan, args: [] })).trainingConfig).toBe(path.join(root, "training/container.json"));
  const another = structuredClone(plan.targets[0]!); another.datasets.train.sourcePath += ".other";
  project.datasets[another.datasets.train.sourcePath] = project.datasets[plan.targets[0]!.datasets.train.sourcePath]!;
  const combined = await lowerTrainingExecution({ project, plan: { ...plan, targets: [...plan.targets, another] }, args: [] });
  expect(combined.execution.authoring.targets).toHaveLength(2);
  expect((await lowerTrainingExecution({ project, plan: { ...plan, targets: [...plan.targets, another] }, args: ["--train", "override"] })).execution.args).toContain("override");
  await expect(lowerTrainingExecution({ project, plan: { ...plan, targets: [] }, args: [] })).rejects.toThrow("no executable training targets");
});
it("allocates canonical private output parents and refuses symlink aliases without writing through them", async () => {
  const root = await executionFixture(), parent = path.join(root, ".spawn/training/writer");
  await allocateTrainingOutputParent(path.join(parent, "run"));
  expect(await realpath(parent)).toBe(parent);
  await allocateTrainingOutputParent(path.join(parent, "run"));
  await mkdir(path.join(root, "real")); await symlink(path.join(root, "real"), path.join(root, "alias"));
  await expect(allocateTrainingOutputParent(path.join(root, "alias/new/output"))).rejects.toThrow("canonical directory");
  expect(await readdir(path.join(root, "real"))).toEqual([]);
});
