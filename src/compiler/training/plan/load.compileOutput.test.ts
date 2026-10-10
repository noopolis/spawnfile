import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { buildCompilePlan } from "../../buildCompilePlan.js";
import { compileProject } from "../../compileProject.js";
import { createTrainingContext } from "../context.js";
import { cleanTrainingProjects, optimizer, target, trainingProject, writeTrainingFile } from "./fixtures.test-helper.js";
import { createTrainingPlan } from "./load.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanTrainingProjects();
});

const emittedFiles = async (directory: string, relative = ""): Promise<Array<{ path: string; bytes: Buffer }>> => {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await emittedFiles(directory, file));
    else files.push({ path: file, bytes: await readFile(path.join(directory, file)) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

it("keeps every emitted compile artifact and the report byte-identical with missing training files", async () => {
  const workspace = { docs: { system: "AGENTS.md" } };
  const agent = { spawnfile_version: "0.1", kind: "agent", name: "writer", runtime: "openclaw", workspace };
  const team = { spawnfile_version: "0.1", kind: "team", name: "newsroom", mode: "swarm",
    shared: { workspace: { docs: { soul: "SOUL.md" } } }, members: [{ id: "writer", ref: "writer" }] };
  const root = await trainingProject({ Spawnfile: team, "SOUL.md": "Shared purpose.\n",
    "writer/Spawnfile": agent, "writer/AGENTS.md": "Write precisely.\n" });
  const outputDirectory = path.join(root, ".spawn");
  // Hold the real compiler's timestamp and output paths constant; compare bytes without removing any fields.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T08:20:31Z"));
  const before = await compileProject(root, { outputDirectory });
  const beforeFiles = await emittedFiles(outputDirectory);
  expect(beforeFiles.map((file) => file.path)).toEqual(expect.arrayContaining([
    "Dockerfile", "entrypoint.sh", path.relative(outputDirectory, before.reportPath)
  ]));
  const declaration = {
    record: { keep: "30d", volumes: [] }, optimizer,
    graders: { writing: "missing/grader.yaml" },
    targets: [{ ...target, files: ["missing/TARGET.md"],
      datasets: { train: "missing/train.yaml", validation: "missing/validation.yaml", test: "missing/test.yaml" } }]
  };
  await writeTrainingFile(root, "Spawnfile", { ...team, shared: { ...team.shared, training: declaration } });
  await writeTrainingFile(root, "writer/Spawnfile", { ...agent, training: declaration });

  const compilePlan = await buildCompilePlan(root);
  expect(compilePlan.nodes).toHaveLength(2);
  expect(compilePlan.nodes.every((node) => node.value.training?.targets.length === 1)).toBe(true);
  const after = await compileProject(root, { outputDirectory });
  expect(await emittedFiles(outputDirectory)).toEqual(beforeFiles);
  expect(JSON.stringify(after.report)).toBe(JSON.stringify(before.report));
  await expect(createTrainingContext(root, { packageVersion: "0.1.17" })).resolves.toMatchObject({
    agent: { id: "agent:writer" }
  });
  await expect(createTrainingPlan(root, { packageVersion: "0.1.17" })).rejects.toMatchObject({
    code: "validation_error", message: expect.stringMatching(/Training target .*missing\/TARGET.md declared by team:newsroom.*existing regular \.md file/u)
  });
});
