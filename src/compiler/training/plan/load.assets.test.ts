import { createHash } from "node:crypto";
import { readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTrainingPlan } from "./resolve.js";
import { createTrainingPlan, loadTrainingProject } from "./load.js";
import { agentManifest, cleanTrainingProjects, dataFiles, training, trainingProject, writeTrainingFile } from "./fixtures.test-helper.js";

const options = { packageVersion: "test" };
afterEach(cleanTrainingProjects);
const fixture = async () => {
  const root = await trainingProject({ Spawnfile: agentManifest({ training: { ...training, targets: [{ ...training.targets[0],
    datasets: { ...training.targets[0].datasets, validation: "training/validation.yaml" } }] } }), "AGENTS.md": dataFiles["AGENTS.md"] });
  const trainingRoot = await trainingProject({ ...dataFiles, "training/validation.yaml": dataFiles["training/train.yaml"], "unlisted-secret": "unlisted" });
  return { root, trainingRoot };
};

it("maps all declared roles and opaque graders before loading, pins exact bytes, and retains editable ownership", async () => {
  const f = await fixture();
  await expect(createTrainingPlan(f.root, options)).rejects.toThrow("existing regular file");
  const project = await loadTrainingProject(f.root, { trainingRoot: f.trainingRoot });
  const plan = await createTrainingPlan(f.root, { ...options, trainingRoot: f.trainingRoot });
  expect(plan.targets[0]!.files[0]!.sourcePath).toBe(path.join(f.root, "AGENTS.md"));
  expect(plan.graders[0]!.sourcePath).toBe(path.join(f.trainingRoot, "training/writing.grader.yaml"));
  expect(plan.assets!.files.map(file => file.path)).toEqual(["training/test.yaml", "training/train.yaml", "training/validation.yaml", "training/writing.grader.yaml"]);
  for (const file of plan.assets!.files) {
    expect(file.sha256).toBe(`sha256:${createHash("sha256").update(await readFile(file.sourcePath)).digest("hex")}`);
    expect(file.sourcePath).toBe(path.join(f.trainingRoot, file.path));
  }
  for (const role of ["train", "validation", "test"] as const) {
    const dataset = plan.targets[0]!.datasets[role]!;
    expect(project.datasets[dataset.sourcePath]!.sha256).toBe(plan.assets!.files.find(file => file.sourcePath === dataset.sourcePath)!.sha256);
  }
  expect(JSON.stringify(plan)).not.toContain("unlisted-secret");
});

it("maps nested declaration-relative references using the project-relative logical path", async () => {
  const f = await fixture();
  const root = await trainingProject({ Spawnfile: { spawnfile_version: "0.1", kind: "team", name: "org", mode: "swarm", members: [{ id: "writer", ref: "writer" }] },
    "writer/Spawnfile": agentManifest(), "writer/AGENTS.md": dataFiles["AGENTS.md"] });
  for (const [file, bytes] of Object.entries(dataFiles)) await writeTrainingFile(f.trainingRoot, `writer/${file}`, bytes);
  const plan = await createTrainingPlan(root, { ...options, trainingRoot: f.trainingRoot });
  expect(plan.graders[0]!.path).toBe("writer/training/writing.grader.yaml");
  expect(plan.targets[0]!.datasets.train.sourcePath).toBe(path.join(f.trainingRoot, "writer/training/train.yaml"));
});

it.each(["project", "inside project", "ancestor", "alias", "missing"])("rejects a %s root", async kind => {
  const f = await fixture();
  let trainingRoot = kind === "project" ? f.root : kind === "inside project" ? path.join(f.root, "assets")
    : kind === "ancestor" ? path.dirname(f.root) : kind === "missing" ? path.join(f.trainingRoot, "missing") : path.join(f.trainingRoot, "alias");
  if (kind === "inside project") await writeTrainingFile(f.root, "assets/file", "fixture");
  if (kind === "alias") await symlink(f.root, trainingRoot);
  await expect(createTrainingPlan(f.root, { ...options, trainingRoot })).rejects.toMatchObject({ code: "validation_error" });
});

it.each(["train", "validation", "test", "grader"])("rejects symlink escapes and aliases for private %s", async role => {
  const f = await fixture(), file = role === "grader" ? "writing.grader.yaml" : `${role}.yaml`;
  await writeTrainingFile(f.trainingRoot, "training/other.yaml", dataFiles["training/train.yaml"]);
  const { rm } = await import("node:fs/promises");
  const source = path.join(f.trainingRoot, "training", file);
  await rm(source);
  await symlink(path.join(f.root, "AGENTS.md"), source);
  await expect(createTrainingPlan(f.root, { ...options, trainingRoot: f.trainingRoot })).rejects.toThrow("symlink escape");
  await rm(source); await symlink("other.yaml", source);
  await expect(createTrainingPlan(f.root, { ...options, trainingRoot: f.trainingRoot })).rejects.toThrow("symlink aliases");
});

it("does not fall back to public bytes or admit an escaping authored reference", async () => {
  const f = await fixture();
  await writeTrainingFile(f.root, "training/missing.yaml", dataFiles["training/train.yaml"]);
  await writeTrainingFile(f.root, "Spawnfile", agentManifest({ training: { ...training,
    targets: [{ ...training.targets[0], datasets: { train: "training/missing.yaml", test: "training/test.yaml" } }] } }));
  await expect(createTrainingPlan(f.root, { ...options, trainingRoot: f.trainingRoot })).rejects.toThrow("existing regular file");
  await writeTrainingFile(f.root, "Spawnfile", agentManifest({ training: { ...training, graders: { writing: "../escape.yaml" } } }));
  await expect(createTrainingPlan(f.root, { ...options, trainingRoot: f.trainingRoot })).rejects.toThrow("reference must be inside project root");
});


it.each([false, true])("reloads a selected multi-agent allowlist including shared targets=%s", async shared => {
  const files: Record<string, unknown> = { Spawnfile: { spawnfile_version: "0.1", kind: "team", name: "org", mode: "swarm",
    ...(shared ? { shared: { workspace: { docs: { soul: "SOUL.md" } },
      training: { ...training, targets: [{ ...training.targets[0], files: ["SOUL.md"] }] } } } : {}),
    members: [{ id: "a", ref: "a" }, { id: "b", ref: "b" }] }, "SOUL.md": "Shared purpose." };
  for (const name of ["a", "b"]) {
    files[`${name}/Spawnfile`] = agentManifest({ name }); files[`${name}/AGENTS.md`] = dataFiles["AGENTS.md"];
  }
  const root = await trainingProject(files), trainingRoot = await trainingProject({});
  for (const prefix of ["a/", "b/", ...shared ? [""] : []]) {
    for (const [file, bytes] of Object.entries(dataFiles).filter(([file]) => file !== "AGENTS.md")) await writeTrainingFile(trainingRoot, `${prefix}${file}`, bytes);
  }
  const complete = await loadTrainingProject(root, { trainingRoot });
  const plan = resolveTrainingPlan(complete, "a", "test"), stagedRoot = await trainingProject({});
  for (const asset of plan.assets!.files) await writeTrainingFile(stagedRoot, asset.path, (await readFile(asset.sourcePath)).toString("utf8"));
  await expect(readFile(path.join(stagedRoot, "b/training/writing.grader.yaml"))).rejects.toThrow();
  await expect(loadTrainingProject(root, { trainingRoot: stagedRoot })).rejects.toThrow("existing regular file");
  const reloaded = await loadTrainingProject(root, { trainingRoot: stagedRoot, agent: plan.agent.id }).then(value => ({ value }), error => ({ error }));
  expect(reloaded, "selected evaluator reload guarantee").toHaveProperty("value");
  if (!("value" in reloaded)) throw Error("selected reload failed");
  const actual = resolveTrainingPlan(reloaded.value, plan.agent.id, "test");
  expect(actual, "selected evaluator reload guarantee").toEqual(JSON.parse(JSON.stringify(plan).replaceAll(trainingRoot, stagedRoot)));
  expect(() => resolveTrainingPlan(reloaded.value, "b", "test")).toThrow("asset scope");
  await expect(createTrainingPlan(root, { ...options, trainingRoot: stagedRoot, agent: "a" })).resolves.toEqual(actual);
});
