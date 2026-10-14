import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import type { TrainingDeclaration } from "../../manifest/index.js";
import { getRuntimeAdapter } from "../../runtime/index.js";
import { buildCompilePlan } from "../buildCompilePlan.js";
import { getAgentFingerprint, getTeamFingerprint } from "../compilePlanHelpers.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "../types.js";
import { mergeTrainingDeclarations, resolveTrainingDeclaration } from "./resolution.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const optimizer = { method: "gepa", model: "claude-opus-5-5", variants: 8, keep: 3, budget: { rounds: 10 } };
const target = { files: ["AGENTS.md"], grader: "writing", datasets: { train: "training/train.yaml", test: "training/test.yaml" } };
const agent = (name: string, training?: TrainingDeclaration) => ({
  spawnfile_version: "0.1", kind: "agent", name, runtime: "openclaw", training,
  workspace: { docs: { system: "AGENTS.md" } }
});
const team = (name: string, members: unknown[], training?: TrainingDeclaration) => ({
  spawnfile_version: "0.1", kind: "team", name, mode: "swarm", members,
  ...(training === undefined ? {} : { shared: { training } })
});
const findAgent = (plan: CompilePlan, name = "author"): ResolvedAgentNode =>
  plan.nodes.find((node) => node.id === `agent:${name}`)!.value as ResolvedAgentNode;
const findTeam = (plan: CompilePlan, name = "publication"): ResolvedTeamNode =>
  plan.nodes.find((node) => node.id === `team:${name}`)!.value as ResolvedTeamNode;

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-resolution-")));
  directories.push(root);
  return root;
}

async function manifest(root: string, directory: string, declaration: unknown): Promise<void> {
  const destination = path.join(root, directory);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "AGENTS.md"), "Operating instructions.\n");
  await writeFile(path.join(destination, "Spawnfile"), stringify(declaration));
}

async function repeatedAgent(
  left: TrainingDeclaration | undefined,
  right: TrainingDeclaration | undefined,
  local?: TrainingDeclaration
): Promise<string> {
  const root = await project();
  await manifest(root, ".", team("publication", [{ id: "left", ref: "left" }, { id: "right", ref: "right" }]));
  await manifest(root, "left", team("left", [{ id: "author", ref: "../author" }], left));
  await manifest(root, "right", team("right", [{ id: "author", ref: "../author" }], right));
  await manifest(root, "author", agent("author", local));
  return root;
}

describe("training graph resolution", () => {
  it("inherits experiment deadlines and locally overrides only the declared trial deadline", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{ id: "author", ref: "author" }], {
      deadlines: { experiment_ms: 60_000_000, trial_ms: 4_000_000 }
    }));
    await manifest(root, "author", agent("author", { deadlines: { trial_ms: 5_000_000 } }));
    expect(findAgent(await buildCompilePlan(root)).training?.deadlines).toEqual({ experiment_ms: 60_000_000, trial_ms: 5_000_000 });
  });
  it("merges fields and nested budgets, replaces arrays and shadows graders at their declaration base", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{ id: "author", ref: "author" }], {
      record: { keep: "30d", volumes: ["team-state", "archive"] }, optimizer,
      graders: { writing: "training/team-writing.yaml", accuracy: "training/accuracy.yaml" },
      targets: [target]
    }));
    await manifest(root, "author", agent("author", {
      record: { volumes: ["personal-state"] }, optimizer: { keep: 2, budget: { rounds: 30 } },
      graders: { writing: "training/local-writing.yaml" },
      targets: [{ ...target, datasets: { ...target.datasets, validation: "training/validation.yaml" } }]
    }));
    const plan = await buildCompilePlan(root);
    const training = findAgent(plan).training!;
    expect(training.record).toEqual({ keep: "30d", volumes: ["personal-state"] });
    expect(training.optimizer).toEqual({ ...optimizer, keep: 2, budget: { rounds: 30 } });
    expect(training.graders).toEqual({
      accuracy: { sourcePath: path.join(root, "training/accuracy.yaml"), declaredBy: "team:publication" },
      writing: { sourcePath: path.join(root, "author/training/local-writing.yaml"), declaredBy: "agent:author" }
    });
    expect(training.targets).toEqual([{
      files: [path.join(root, "author/AGENTS.md")], grader: "writing",
      datasets: { train: path.join(root, "author/training/train.yaml"),
        validation: path.join(root, "author/training/validation.yaml"), test: path.join(root, "author/training/test.yaml") }
    }]);
    expect(findTeam(plan).training).toMatchObject({ optimizer, record: { keep: "30d", volumes: ["team-state", "archive"] },
      graders: { writing: { sourcePath: path.join(root, "training/team-writing.yaml"), declaredBy: "team:publication" } },
      targets: [{ files: [path.join(root, "AGENTS.md")] }] });
  });

  it("keeps inherited optimizer fields and budget when a closer declaration leaves them out", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{ id: "author", ref: "author" }], { optimizer }));
    await manifest(root, "author", agent("author", { optimizer: { model: "local-model", budget: {} } }));
    expect(findAgent(await buildCompilePlan(root)).training?.optimizer).toEqual({ ...optimizer, model: "local-model" });
  });

  it("replaces record arrays even with an empty array", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{ id: "author", ref: "author" }], { record: { keep: "1d", volumes: ["state"] } }));
    await manifest(root, "author", agent("author", { record: { volumes: [] } }));
    expect(findAgent(await buildCompilePlan(root)).training?.record).toEqual({ keep: "1d", volumes: [] });
  });

  it("never inherits targets, including a shared declaration containing only targets", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{ id: "author", ref: "author" }], { targets: [target] }));
    await manifest(root, "author", agent("author"));
    const plan = await buildCompilePlan(root);
    expect(findAgent(plan).training).toBeUndefined();
    expect(findTeam(plan).training?.targets).toHaveLength(1);
  });

  it("applies shared training to inline members and preserves their distinct declaring node", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{
      id: "author", runtime: "openclaw", workspace: { docs: { system: "AGENTS.md" } },
      training: { optimizer: { budget: { rounds: 20 } }, graders: { writing: "local.yaml" }, targets: [target] }
    }], { optimizer, graders: { inherited: "shared.yaml" } }));
    expect(findAgent(await buildCompilePlan(root)).training).toEqual({
      optimizer: { ...optimizer, budget: { rounds: 20 } },
      graders: { inherited: { sourcePath: path.join(root, "shared.yaml"), declaredBy: "team:publication" },
        writing: { sourcePath: path.join(root, "local.yaml"), declaredBy: "agent:author" } },
      targets: [{ ...target, files: [path.join(root, "AGENTS.md")],
        datasets: { train: path.join(root, "training/train.yaml"), test: path.join(root, "training/test.yaml") } }]
    });
  });

  it("does not propagate shared training through a nested team boundary", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{ id: "child", ref: "child" }], {
      record: { keep: "30d", volumes: ["parent-state"] }, optimizer, graders: { writing: "parent.yaml" }
    }));
    await manifest(root, "child", team("child", [{ id: "author", ref: "author" }], { record: { keep: "9h" } }));
    await manifest(root, "child/author", agent("author"));
    const plan = await buildCompilePlan(root);
    expect(findAgent(plan).training).toEqual({ record: { keep: "9h" }, graders: {}, targets: [] });
    expect(findTeam(plan, "child").training).toEqual({ record: { keep: "9h" }, graders: {}, targets: [] });
  });

  it("does not give a subagent its parent's inherited or local training", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{ id: "author", ref: "author" }], {
      optimizer, graders: { writing: "team.yaml" }, record: { keep: "30d" }
    }));
    await manifest(root, "author", { ...agent("author", { record: { volumes: ["local"] } }),
      subagents: [{ id: "critic", ref: "critic" }, { id: "local", ref: "local" }] });
    await manifest(root, "author/critic", agent("critic"));
    await manifest(root, "author/local", agent("local", { record: {} }));
    const plan = await buildCompilePlan(root);
    expect(findAgent(plan).training?.optimizer).toEqual(optimizer);
    expect(findAgent(plan, "critic").training).toBeUndefined();
    expect(findAgent(plan, "local").training).toEqual({ record: {}, graders: {}, targets: [] });
  });

  it("rejects different effective training across repeated agent imports as a validation error", async () => {
    const root = await repeatedAgent({ optimizer }, { optimizer: { ...optimizer, budget: { rounds: 20 } } });
    await expect(buildCompilePlan(root)).rejects.toMatchObject({
      code: "validation_error", message: "Agent author resolves with incompatible training across team imports"
    });
  });

  it("accepts the same effective training through two teams, including fields shadowed locally", async () => {
    const root = await repeatedAgent(
      { record: { keep: "1d", volumes: ["state"] }, optimizer },
      { record: { keep: "2d", volumes: ["state"] }, optimizer: { ...optimizer, budget: { rounds: 20 } } },
      { record: { keep: "3d" }, optimizer: { budget: { rounds: 30 } } }
    );
    const plan = await buildCompilePlan(root);
    expect(plan.nodes.filter((node) => node.kind === "agent")).toHaveLength(1);
    expect(findAgent(plan).training).toEqual({ record: { keep: "3d", volumes: ["state"] },
      optimizer: { ...optimizer, budget: { rounds: 30 } }, graders: {}, targets: [] });
  });

  it("includes resolved grader paths and declaring provenance in compatibility checks", async () => {
    const root = await repeatedAgent({ graders: { writing: "same.yaml" } }, { graders: { writing: "same.yaml" } });
    await expect(buildCompilePlan(root)).rejects.toMatchObject({ code: "validation_error", message: expect.stringContaining("incompatible training") });
  });

  it("keeps declaration key order irrelevant to repeated imports", async () => {
    const root = await repeatedAgent({ optimizer, record: { keep: "1d", volumes: [] } },
      { record: { volumes: [], keep: "1d" }, optimizer: { budget: { rounds: 10 }, keep: 3, variants: 8, model: optimizer.model, method: "gepa" } });
    expect(findAgent(await buildCompilePlan(root)).training?.optimizer).toEqual(optimizer);
  });

  it("includes all training metadata in agent and team fingerprints", async () => {
    const root = await project();
    await manifest(root, ".", team("publication", [{ id: "author", ref: "author" }], { optimizer }));
    await manifest(root, "author", agent("author"));
    const plan = await buildCompilePlan(root);
    for (const node of [findAgent(plan), findTeam(plan)]) {
      const invoke = (value: typeof node) => value.kind === "agent" ? getAgentFingerprint(value) : getTeamFingerprint(value);
      const baseline = invoke(node);
      const training = node.training!;
      for (const change of [
        { ...training, record: {} }, { ...training, optimizer: { ...optimizer, keep: 1 } },
        { ...training, graders: { writing: { sourcePath: path.join(root, "writing.yaml"), declaredBy: "team:publication" } } },
        { ...training, targets: [target] }
      ]) expect(invoke({ ...node, training: change })).not.toBe(baseline);
    }
  });

  it("retains recording presence, but treats absent and empty effective training alike", () => {
    expect(mergeTrainingDeclarations(undefined, resolveTrainingDeclaration({}, "/project/Spawnfile", "agent:author"))).toBeUndefined();
    expect(mergeTrainingDeclarations(undefined, resolveTrainingDeclaration({ record: {} }, "/project/Spawnfile", "agent:author")))
      .toEqual({ record: {}, graders: {}, targets: [] });
  });

  it("leaves native adapter emission unchanged", async () => {
    const root = await project();
    await manifest(root, ".", agent("author"));
    const before = findAgent(await buildCompilePlan(root));
    await manifest(root, ".", agent("author", { record: { keep: "1d" }, optimizer, graders: { writing: "writing.yaml" }, targets: [target] }));
    const after = findAgent(await buildCompilePlan(root));
    const adapter = getRuntimeAdapter("openclaw");
    expect(await adapter.compileAgent(after)).toEqual(await adapter.compileAgent(before));
    expect({ ...after, training: undefined }).toEqual(before);
  });
});
