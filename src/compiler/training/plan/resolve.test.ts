import { readFile, realpath, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTrainingPlan, loadTrainingProject } from "./load.js";
import { resolveTrainingPlan } from "./resolve.js";
import { trainingPlanSchema } from "./contract.js";
import {
  agentManifest, cleanTrainingProjects, dataFiles, example, optimizer, target, teamFiles,
  training, trainingProject, volume, writeTrainingFile
} from "./fixtures.test-helper.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile), realpath: vi.fn(actual.realpath), stat: vi.fn(actual.stat) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(async () => {
  vi.mocked(readFile).mockImplementation(actual.readFile);
  vi.mocked(realpath).mockImplementation(actual.realpath);
  vi.mocked(stat).mockImplementation(actual.stat);
  await cleanTrainingProjects();
});
const options = { packageVersion: "0.1.17" };

describe("pure training plan resolution", () => {
  it("declares a twelve-hour experiment default and retains authored independent deadlines", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    expect((await createTrainingPlan(root, options)).deadlines).toEqual({ experiment_ms: 43_200_000 });
    await writeTrainingFile(root, "Spawnfile", agentManifest({ training: { ...training,
      deadlines: { experiment_ms: 60_000_000, trial_ms: 5_000_000 } } }));
    expect((await createTrainingPlan(root, options)).deadlines).toEqual({ experiment_ms: 60_000_000, trial_ms: 5_000_000 });
  });
  it("resolves twice identically without I/O, clock reads, or input mutation", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    const project = await loadTrainingProject(root);
    const before = structuredClone(project);
    const noIo = () => { throw new Error("pure resolver attempted I/O"); };
    vi.mocked(readFile).mockClear().mockImplementation(noIo);
    vi.mocked(realpath).mockClear().mockImplementation(noIo);
    vi.mocked(stat).mockClear().mockImplementation(noIo);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw Error("clock read"); });
    try {
      const first = resolveTrainingPlan(project, undefined, options.packageVersion);
      expect(resolveTrainingPlan(project, "agent:writer", options.packageVersion)).toEqual(first);
      expect(first.optimizer).toEqual(optimizer);
      expect(first.record).toBeNull();
      expect(project).toEqual(before);
      expect(readFile).not.toHaveBeenCalled(); expect(realpath).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
      expect(clock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("sorts arrays and recursively sorts object keys regardless of author ordering", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    await writeTrainingFile(root, "training/train.yaml", { examples: [{ ...example, id: "z-last" }, { ...example, id: "a-first" }] });
    const plan = await createTrainingPlan(root, options);
    expect(plan.targets[0].datasets.train.examples.map((entry) => entry.id)).toEqual(["a-first", "z-last"]);
    const checkKeys = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(checkKeys);
      else if (value !== null && typeof value === "object") {
        expect(Object.keys(value)).toEqual(Object.keys(value).sort());
        Object.values(value).forEach(checkKeys);
      }
    };
    checkKeys(plan);
  });

  it("accepts unambiguous short names and infers only a one-agent graph", async () => {
    const root = await trainingProject(teamFiles());
    const project = await loadTrainingProject(root);
    for (const id of [undefined, "unknown", "team:publication", "agent:missing"]) {
      expect(() => resolveTrainingPlan(project, id, options.packageVersion)).toThrow(/--agent|No canonical agent/u);
    }
    expect(resolveTrainingPlan(project, "a", options.packageVersion).agent.id).toBe("agent:a");
    expect(resolveTrainingPlan(project, "agent:a", options.packageVersion).agent.id).toBe("agent:a");
  });

  it("sorts target files authored in reverse order", async () => {
    const root = await trainingProject({ ...dataFiles, "Z.md": "Last\n", "A.md": "First\n",
      Spawnfile: agentManifest({ workspace: { docs: { system: "Z.md", soul: "A.md" } },
        training: { ...training, targets: [{ ...target, files: ["Z.md", "A.md"] }] } })
    });
    const project = await loadTrainingProject(root);
    expect(project.targets[0].files.map((file) => file.path)).toEqual(["Z.md", "A.md"]);
    expect(resolveTrainingPlan(project, undefined, options.packageVersion).targets[0].files.map((file) => file.path))
      .toEqual(["A.md", "Z.md"]);
  });

  it("sorts record volumes authored in reverse order", async () => {
    const ids = ["z-state", "a-state"];
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      workspace: { docs: { system: "AGENTS.md" },
        resources: ids.map((id) => ({ ...volume, id, mount: `./${id}` })) },
      training: { ...training, record: { volumes: ids } }
    }) });
    expect((await createTrainingPlan(root, options)).record?.volumes).toEqual([
      { id: "a-state", declaredBy: "agent:writer" }, { id: "z-state", declaredBy: "agent:writer" }
    ]);
  });

  it.each(["method", "model", "variants", "keep", "budget.rounds"])("names missing optimizer field %s when targets apply", async (field) => {
    const incomplete: Record<string, unknown> = structuredClone(optimizer);
    if (field === "budget.rounds") incomplete.budget = {};
    else delete incomplete[field];
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({ training: { ...training, optimizer: incomplete } }) });
    await expect(createTrainingPlan(root, options)).rejects.toThrow(`missing fields: ${field}`);
  });

  it("names every missing optimizer field and rejects keep greater than variants", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({ training: { ...training, optimizer: undefined } }) });
    await expect(createTrainingPlan(root, options)).rejects.toThrow("method, model, variants, keep, budget.rounds");
    await writeTrainingFile(root, "Spawnfile", agentManifest({ training: { ...training, optimizer: { ...optimizer, keep: 9 } } }));
    await expect(createTrainingPlan(root, options)).rejects.toThrow("keep <= variants");
  });

  it("permits partial declarations without targets and emits optimizer null", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({ training: { optimizer: { budget: { rounds: 2 } } } }) });
    const plan = await createTrainingPlan(root, options);
    expect(plan.optimizer).toBeNull(); expect(plan.targets).toEqual([]); expect(plan.graders).toEqual([]);
  });

  it("keeps all plan records strict", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    const plan = await createTrainingPlan(root, options);
    expect(trainingPlanSchema.safeParse({ ...plan, environment: {} }).success).toBe(false);
    expect(trainingPlanSchema.safeParse({ ...plan, optimizer: { ...plan.optimizer, unexpected: 1 } }).success).toBe(false);
    expect(trainingPlanSchema.safeParse({ ...plan, targets: [{ ...plan.targets[0], files: [] }] }).success).toBe(false);
  });
});
