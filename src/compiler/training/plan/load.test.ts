import { mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCompilePlan } from "../../buildCompilePlan.js";
import { loadTrainingProject, createTrainingPlan } from "./load.js";
import { trainingPlanJsonSchema, trainingPlanSchema } from "./contract.js";
import { materializedMomentJsonSchema, leakCheckJsonSchema, taskClockJsonSchema } from "../rewind/contract.js";
import {
  agentManifest, cleanTrainingProjects, dataFiles, example, target, teamManifest, training,
  trainingProject, writeTrainingFile
} from "./fixtures.test-helper.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
afterEach(() => vi.clearAllMocks());
afterEach(cleanTrainingProjects);
const options = { packageVersion: "0.1.17" };
type DataRole = "train" | "validation" | "test" | "grader";
const manifestWithDataFile = (role: DataRole, file: string) => agentManifest({ training: {
  ...training,
  ...(role === "grader" ? { graders: { writing: file } }
    : { targets: [{ ...target, datasets: { ...target.datasets, [role]: file } }] })
} });

describe("training authoring loader", () => {
  it("reads dataset YAML, never reads grader contents, and emits only file references for graders", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    const graderPath = path.join(root, "training/writing.grader.yaml");
    const project = await loadTrainingProject(root);
    expect(project.graders[graderPath]).toEqual({ sourcePath: graderPath, path: "training/writing.grader.yaml" });
    const plan = await createTrainingPlan(path.join(root, "Spawnfile"), options);
    expect(trainingPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.graders).toEqual([{ name: "writing", declaredBy: "agent:writer",
      sourcePath: graderPath, path: "training/writing.grader.yaml" }]);
    expect(plan.targets[0].datasets.test.path).toBe("training/test.yaml");
    expect(plan.targets[0].datasets.validation).toBeNull();
    expect(plan.targets[0].datasets.train.examples).toEqual([{ ...example, overrides: [] }]);
    expect(vi.mocked(readFile).mock.calls.map(([file]) => file)).not.toContain(graderPath);
    expect(await readdir(root)).toEqual(["AGENTS.md", "Spawnfile", "training"]);
  });

  it.each([
    ["training/train.yaml", "examples: []\nexamples: []\n"],
    ["training/train.yaml", { examples: [{ ...example, extra: "no" }] }]
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

  it.each(["train", "validation", "test", "grader"])("compiles without a missing %s file but plan loading names it", async (role) => {
    const file = role === "grader" ? "training/writing.grader.yaml" : `training/${role}.yaml`;
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      training: { ...training, targets: [{ ...target, datasets: { ...target.datasets, validation: "training/validation.yaml" } }] }
    }), "training/validation.yaml": { examples: [example] } });
    await rm(path.join(root, file));
    await expect(buildCompilePlan(root)).resolves.toMatchObject({ root: path.join(root, "Spawnfile") });
    await expect(loadTrainingProject(root)).rejects.toMatchObject({
      code: "validation_error", message: expect.stringContaining(`Invalid training file ${path.join(root, file)} declared by agent:writer:`)
    });
  });

  it("preserves valid POSIX relative names containing a colon", async () => {
    const root = await trainingProject({ ...dataFiles, "C:notes.md": "Portable source text\n",
      Spawnfile: agentManifest({ workspace: { docs: { system: "C:notes.md" } },
        training: { ...training, targets: [{ ...target, files: ["C:notes.md"] }] } }) });
    expect((await createTrainingPlan(root, options)).targets[0].files[0].path).toBe("C:notes.md");
  });

  it.each([
    ["training-plan-schema", trainingPlanJsonSchema],
    ["materialized-moment-schema", materializedMomentJsonSchema],
    ["leak-check-schema", leakCheckJsonSchema],
    ["task-clock-schema", taskClockJsonSchema]
  ])("keeps the documented %s identical to the exported contract", async (marker, expected) => {
    const doc = await readFile(new URL("../../../../specs/TRAINING.md", import.meta.url), "utf8");
    const pattern = "<!-- " + marker + ":start -->\\n```json\\n([\\s\\S]*?)\\n```";
    const schema = doc.match(new RegExp(pattern, "u"))?.[1];
    expect(JSON.parse(schema!)).toEqual(expected);
  });
});

describe.each<DataRole>(["train", "validation", "test", "grader"])("training %s file containment", (role) => {
  it.each(["parent escape", "symlink escape", "outside symlink back inside", "missing", "directory"])(
    "rejects a %s in the loader before reading contents", async (kind) => {
      const file = kind === "parent escape" ? "../outside.yaml"
        : kind === "outside symlink back inside" ? "../back.yaml" : "training/checked.yaml";
      const parent = await trainingProject({
        "outside.yaml": { examples: [example] },
        ...Object.fromEntries(Object.entries(dataFiles).map(([name, value]) => [`project/${name}`, value])),
        "project/Spawnfile": manifestWithDataFile(role, file)
      });
      const root = path.join(parent, "project");
      const sourcePath = path.resolve(root, file);
      if (kind === "symlink escape") await symlink(path.join(parent, "outside.yaml"), sourcePath);
      if (kind === "outside symlink back inside") await symlink(path.join(root, "training/train.yaml"), sourcePath);
      if (kind === "directory") await mkdir(sourcePath);
      const error: unknown = await loadTrainingProject(root).catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        code: "validation_error",
        message: expect.stringContaining(`Invalid training file ${sourcePath} declared by agent:writer:`)
      });
      expect((error as Error).message).toContain(kind === "missing" || kind === "directory"
        ? "existing regular file" : "inside project root");
      expect(vi.mocked(readFile).mock.calls.map(([readPath]) => readPath)).not.toContain(sourcePath);
    }
  );

  it("resolves from the declaring manifest and permits symlinks within the compiled project root", async () => {
    const root = await trainingProject({
      ...Object.fromEntries(Object.entries(dataFiles).map(([name, value]) => [`writer/${name}`, value])),
      Spawnfile: teamManifest({ shared: undefined, networks: undefined, memory: undefined,
        members: [{ id: "writer", ref: "writer" }] }),
      "writer/Spawnfile": manifestWithDataFile(role, "../shared/link.yaml"),
      "shared/data.yaml": { examples: [example] }
    });
    await symlink("data.yaml", path.join(root, "shared/link.yaml"));
    const plan = await createTrainingPlan(root, options);
    const file = role === "grader" ? plan.graders[0] : plan.targets[0].datasets[role];
    expect(file).toMatchObject({ sourcePath: path.join(root, "shared/link.yaml"), path: "shared/link.yaml" });
  });
});

describe("nested Spawnfile inspection", () => {
  const nestedTargetProject = () => trainingProject({ ...dataFiles, "nested/NOTES.md": "Notes\n",
    Spawnfile: agentManifest({ workspace: { docs: { system: "nested/NOTES.md" } },
      training: { ...training, targets: [{ ...target, files: ["nested/NOTES.md"] }] } })
  });

  it("reports a nested Spawnfile symlink loop as a validation error naming the target", async () => {
    const root = await nestedTargetProject();
    await symlink("Spawnfile", path.join(root, "nested/Spawnfile"));
    const error: unknown = await loadTrainingProject(root).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "validation_error" });
    expect((error as Error).message).toContain(path.join(root, "nested/NOTES.md"));
    expect((error as Error).message).toContain(path.join(root, "nested/Spawnfile"));
    expect((error as Error).message).toContain("ELOOP");
  });

  it("still follows nested Spawnfile symlinks for ownership", async () => {
    const root = await nestedTargetProject();
    await symlink("../Spawnfile", path.join(root, "nested/Spawnfile"));
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/nested\/NOTES.md.*nested Spawnfile/u);
  });

  it.each(["missing", "directory", "dangling symlink"])("ignores a %s nested Spawnfile", async (kind) => {
    const root = await nestedTargetProject();
    const manifest = path.join(root, "nested/Spawnfile");
    if (kind === "directory") await mkdir(manifest);
    if (kind === "dangling symlink") await symlink("missing", manifest);
    expect((await createTrainingPlan(root, options)).targets[0].files[0].path).toBe("nested/NOTES.md");
  });
});
