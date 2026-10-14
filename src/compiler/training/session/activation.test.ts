import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTrainingContext } from "../context.js";
import type { TrainingExecution } from "../execution.js";
import { loadTrainingProject, resolveTrainingPlan } from "../plan/index.js";
import { agentManifest, cleanTrainingProjects, training, target, writeTrainingFile } from "../plan/fixtures.test-helper.js";
import { activateTrainingExecution } from "./activation.js";
import { prepareTrainingSessionSlot } from "./slot.js";
import { activationFixture } from "./activation.test-helper.js";

afterEach(cleanTrainingProjects);
const fixture = async () => {
  const f = await activationFixture();
  return { ...f, prepareCase: vi.fn(f.prepareCase) };
};
const resume = (execution: TrainingExecution): TrainingExecution => ({ ...execution, args: [...execution.args, "--resume"] });

const checkRefusal = async (attempt: Promise<unknown>, reason: string, label: string) => {
  const result = await attempt.catch((error: unknown) => error);
  expect(result, label).toBeInstanceOf(Error);
  expect((result as Error).message, label).toContain(reason);
};

it("activates the emitted v4 declaration with real lowering, rewind and candidate compiler operations", async () => {
  const f = await fixture(), activated = await activateTrainingExecution(f);
  expect(activated.execution.session).toEqual({ version: "spawnfile.training-session.v1", slots: 2 });
  expect(f.prepareCase).toHaveBeenCalledTimes(3);
  expect(activated.args[activated.args.indexOf("--train") + 1], "activation dataset replacement guarantee").toBe(activated.datasets.train);
  expect(activated.args[activated.args.indexOf("--test") + 1]).toBe(activated.datasets.test);
  expect(activated.args[activated.args.indexOf("--validation") + 1]).toBe(activated.datasets.validation);
  expect(activated.args[activated.args.indexOf("--out") + 1]).toBe(f.execution.output);
  expect(activated.operations.prepareTrainingSessionSlot).toBe(prepareTrainingSessionSlot);
  const dataset = JSON.parse(await readFile(activated.datasets.train, "utf8"));
  expect(dataset.records[0].setup.trainingMoment.hook).toBe("fixture/prepare");
  const moment = await activated.materializeTrainingCase({ moment: dataset.records[0].setup.trainingMoment, out: path.join(f.root, "fresh-rewind") });
  expect(moment.status).toBe("materialized");
  const result = await activated.operations.compileTrainingCandidate({ context: f.context,
    resources: [{ sourcePath: "AGENTS.md", sourceContent: "Write precisely.\n", content: "Use verified facts.\n", edit: "editable" }],
    out: path.join(f.root, "candidate") });
  expect(await readFile(path.join(result.agent.outputDirectory, "workspace/AGENTS.md"), "utf8"), "activation real compiler guarantee").toContain("Use verified facts.");
  expect(result.native).toBeDefined();
});

it("refuses incomplete, duplicate and changed dataset pins before lowering", async () => {
  for (const change of ["missing", "duplicate", "changed"]) {
    const f = await fixture();
    const execution = structuredClone(f.execution);
    if (change === "missing") execution.datasetPins.pop();
    if (change === "duplicate") execution.datasetPins.push(execution.datasetPins[0]!);
    if (change === "changed") execution.datasetPins[0]!.sha256 = `sha256:${"0".repeat(64)}`;
    await checkRefusal(activateTrainingExecution({ ...f, execution }), "dataset pins", "activation dataset pin guarantee");
    expect(f.prepareCase).not.toHaveBeenCalled();
  }
});

it("refuses authoring and context identity drift before executing the private hook", async () => {
  const f = await fixture();
  await checkRefusal(activateTrainingExecution({ ...f, execution: { ...f.execution, authoring: { ...f.execution.authoring,
    agent: { ...f.execution.authoring.agent, name: "other" } } } }), "authoring differs", "activation authoring identity guarantee");
  await checkRefusal(activateTrainingExecution({ ...f, context: { ...f.context,
    project: { ...f.context.project, sourceDigest: `sha256:${"0".repeat(64)}` } } }), "context differs", "activation context identity guarantee");
  await writeFile(path.join(f.projectRoot, "AGENTS.md"), "Changed canonical instructions.\n");
  await expect(activateTrainingExecution(f)).rejects.toThrow("context differs");
  expect(f.prepareCase).not.toHaveBeenCalled();
});

it("resumes only exact pinned lowered bytes without rerunning the case authoring hook", async () => {
  const f = await fixture(), first = await activateTrainingExecution(f);
  f.prepareCase.mockClear();
  const second = await activateTrainingExecution({ ...f, execution: resume(f.execution) });
  expect(second.datasets).toEqual(first.datasets);
  expect(f.prepareCase, "activation resume reuse guarantee").not.toHaveBeenCalled();
  await writeFile(first.datasets.train, "{}");
  await checkRefusal(activateTrainingExecution({ ...f, execution: resume(f.execution) }), "pinned bytes", "activation resume byte pin guarantee");
});

it("refuses changed resume identity, incomplete lowering and added moment evidence", async () => {
  const f = await fixture(), activated = await activateTrainingExecution(f);
  const execution = resume(f.execution);
  execution.optimizer = { ...execution.optimizer, variants: execution.optimizer.variants + 1 };
  await checkRefusal(activateTrainingExecution({ ...f, execution }), "immutable activation receipt", "activation resume identity guarantee");
  await writeFile(path.join(path.dirname(activated.datasets.train), "extra-proof"), "changed");
  await expect(activateTrainingExecution({ ...f, execution: resume(f.execution) })).rejects.toThrow("pinned bytes");
  await rm(path.join(f.execution.output, ".spawnfile-execution/receipt.json"));
  await expect(activateTrainingExecution({ ...f, execution: resume(f.execution) })).rejects.toThrow("ENOENT");
  await expect(activateTrainingExecution(f)).rejects.toThrow("EEXIST");
});

it("binds authored editability and canonical context for every candidate", async () => {
  const f = await fixture();
  await writeTrainingFile(f.projectRoot, "LOCKED.md", "Locked source.\n");
  const manifest = agentManifest({ workspace: { docs: { system: "AGENTS.md", soul: "LOCKED.md" } }, training: {
    ...training, targets: [{ ...target, datasets: { ...target.datasets, validation: "training/validation.yaml" } }], preparation: { hook: "fixture/prepare", history: "history" } } });
  await writeTrainingFile(f.projectRoot, "Spawnfile", manifest);
  const project = await loadTrainingProject(f.projectRoot);
  f.execution.authoring = resolveTrainingPlan(project, "writer", "test");
  f.context = await createTrainingContext(f.projectRoot, { packageVersion: "test" });
  const activated = await activateTrainingExecution(f);
  await checkRefusal(activated.operations.compileTrainingCandidate({ context: f.context,
    resources: [{ sourcePath: "LOCKED.md", sourceContent: "Locked source.\n", content: "Changed", edit: "editable" }],
    out: path.join(f.root, "candidate") }), "unauthored", "activation authored editability guarantee");
  await expect(activated.operations.compileTrainingCandidate({ context: { ...f.context, agent: { ...f.context.agent, name: "foreign" } },
    resources: [], out: path.join(f.root, "candidate") })).rejects.toThrow("activated canonical identity");
});

it("rejects unsafe activation outputs and legacy or dry-run sessions", async () => {
  const f = await fixture();
  await expect(activateTrainingExecution({ ...f, execution: { ...f.execution, session: undefined } })).rejects.toThrow("leased session");
  await expect(activateTrainingExecution({ ...f, execution: { ...f.execution, args: [...f.execution.args, "--dry-run"] } })).rejects.toThrow("host estimator");
  await expect(activateTrainingExecution({ ...f, execution: { ...f.execution, output: path.join(f.root, "other") } })).rejects.toThrow("output differs");
  await expect(activateTrainingExecution({ ...f, execution: { ...f.execution, args: [...f.execution.args, "--out", f.execution.output] } })).rejects.toThrow("output differs");
  const alias = path.join(f.root, "alias"); await symlink(f.execution.output, alias);
  const execution = { ...f.execution, output: alias, args: f.execution.args.map(value => value === f.execution.output ? alias : value) };
  await expect(activateTrainingExecution({ ...f, execution })).rejects.toThrow("canonical");
});

it("refuses resume dataset-role omission even when all lowered byte pins match", async () => {
  const f = await fixture();
  await activateTrainingExecution(f);
  const file = path.join(f.execution.output, ".spawnfile-execution/receipt.json");
  const receipt = JSON.parse(await readFile(file, "utf8"));
  delete receipt.datasets.validation;
  await chmod(file, 0o600);
  await writeFile(file, JSON.stringify(receipt));
  await checkRefusal(activateTrainingExecution({ ...f, execution: resume(f.execution) }),
    "dataset roles", "activation complete resume roles guarantee");
});

it("preserves the explicit optimizer-model override without changing the authored declaration", async () => {
  const f = await fixture();
  f.execution.optimizer.model = "override-model";
  f.execution.args[f.execution.args.indexOf("--optimizer-model") + 1] = "override-model";
  const activated = await activateTrainingExecution(f);
  expect(activated.execution.authoring.optimizer?.model).toBe(training.optimizer.model);
  expect(activated.execution.optimizer.model).toBe("override-model");
  expect(activated.args[activated.args.indexOf("--optimizer-model") + 1]).toBe("override-model");
  const resumed = await activateTrainingExecution({ ...f, execution: resume(f.execution) });
  expect(resumed.identity).toEqual(activated.identity);
});
