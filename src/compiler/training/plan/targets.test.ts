import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTrainingPlan } from "./load.js";
import {
  agentManifest, cleanTrainingProjects, dataFiles, target, teamFiles, teamManifest, training,
  trainingProject, writeTrainingFile
} from "./fixtures.test-helper.js";

afterEach(cleanTrainingProjects);
const options = { packageVersion: "0.1.17" };

describe("training target ownership", () => {
  it("rejects files outside their declaring directory even when another agent consumes them", async () => {
    const root = await trainingProject({
      ...dataFiles, Spawnfile: teamManifest({ shared: undefined, memory: undefined, networks: undefined,
        members: [{ id: "writer", ref: "writer" }] }),
      ...Object.fromEntries(Object.entries(dataFiles).map(([name, value]) => [`writer/${name}`, value])),
      "writer/Spawnfile": agentManifest({
        workspace: { docs: { system: "../AGENTS.md" } },
        training: { ...training, targets: [{ ...target, files: ["../AGENTS.md"] }] }
      })
    });
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/AGENTS.md declared by agent:writer.*inside/u);
  });

  it("rejects ownership inside a nested Spawnfile even if it is not in the graph", async () => {
    const root = await trainingProject({
      ...dataFiles, "nested/Spawnfile": "A separate owner, not traversed.\n", "nested/NOTES.md": "Notes\n",
      Spawnfile: agentManifest({ workspace: { docs: { system: "nested/NOTES.md" } },
        training: { ...training, targets: [{ ...target, files: ["nested/NOTES.md"] }] } })
    });
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/nested\/NOTES.md declared by agent:writer.*nested Spawnfile/u);
  });

  it("rejects a symlink escape before consumer matching", async () => {
    const outside = await trainingProject({ "OUTSIDE.md": "Outside\n" });
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      training: { ...training, targets: [{ ...target, files: ["ESCAPE.md"] }] }
    }) });
    await symlink(path.join(outside, "OUTSIDE.md"), path.join(root, "ESCAPE.md"));
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/ESCAPE.md declared by agent:writer.*symlink/u);
  });

  it("uses realpath to reject a consumed file escaping through a symlinked directory", async () => {
    const outside = await trainingProject({ "OUTSIDE.md": "Outside\n" });
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      workspace: { docs: { system: "linked/OUTSIDE.md" } },
      training: { ...training, targets: [{ ...target, files: ["linked/OUTSIDE.md"] }] }
    }) });
    await symlink(outside, path.join(root, "linked"));
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/linked\/OUTSIDE.md declared by agent:writer.*symlink escape/u);
  });

  it.each(["unused", "missing", "directory"])("rejects a %s target with the file and declaring node", async (kind) => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      training: { ...training, targets: [{ ...target, files: ["NOTES.md"] }] }
    }) });
    if (kind === "unused") await writeTrainingFile(root, "NOTES.md", "Unused\n");
    if (kind === "directory") await mkdir(path.join(root, "NOTES.md"));
    await expect(createTrainingPlan(root, options)).rejects.toThrow(/NOTES.md declared by agent:writer/u);
    if (kind === "unused") await expect(createTrainingPlan(root, options)).rejects.toThrow(/not consumed/u);
    if (kind === "directory") await expect(createTrainingPlan(root, options)).rejects.toThrow(/regular .md file/u);
  });

  it("accepts consumed skill entry files", async () => {
    const root = await trainingProject({ ...dataFiles,
      "skills/writing/SKILL.md": "---\nname: writing\ndescription: Write well.\n---\nWrite.\n",
      Spawnfile: agentManifest({ workspace: { skills: [{ ref: "skills/writing" }] },
        training: { ...training, targets: [{ ...target, files: ["skills/writing/SKILL.md"] }] } })
    });
    expect((await createTrainingPlan(root, options)).targets[0].files[0]).toEqual({
      sourcePath: path.join(root, "skills/writing/SKILL.md"), path: "skills/writing/SKILL.md", consumers: ["agent:writer"]
    });
  });

  it("lists every sorted team consumer and preserves the team's grader despite agent shadowing", async () => {
    const root = await trainingProject(teamFiles());
    await writeTrainingFile(root, "a/Spawnfile", agentManifest({ name: "a", training: {
      graders: { writing: "own.grader.yaml" },
      targets: [{ ...target, datasets: { train: "../training/train.yaml", test: "../training/test.yaml" } }]
    } }));
    await writeTrainingFile(root, "a/own.grader.yaml", "Local calibrated decision model\n");
    const plan = await createTrainingPlan(root, { ...options, agent: "agent:a" });
    expect(plan.targets.map((entry) => [entry.declaredBy, entry.files[0].consumers])).toEqual([
      ["agent:a", ["agent:a"]], ["team:publication", ["agent:a", "agent:b"]]
    ]);
    expect(plan.graders.map((entry) => [entry.name, entry.declaredBy, entry.path])).toEqual([
      ["writing", "agent:a", "a/own.grader.yaml"], ["writing", "team:publication", "training/writing.grader.yaml"]
    ]);
    expect((await createTrainingPlan(root, { ...options, agent: "agent:b" })).targets).toHaveLength(1);
  });

  it("requires the declaring team's grader rather than borrowing an agent-local name", async () => {
    const root = await trainingProject(teamFiles());
    const team = teamManifest();
    await writeTrainingFile(root, "Spawnfile", { ...team, shared: { ...team.shared,
      training: { optimizer: training.optimizer, targets: [{ ...target, files: ["SOUL.md"] }] }
    } });
    await writeTrainingFile(root, "a/Spawnfile", agentManifest({ name: "a", training: {
      graders: { writing: "../training/writing.grader.yaml" }
    } }));
    await expect(createTrainingPlan(root, { ...options, agent: "agent:a" })).rejects.toThrow(/team:publication.*unknown grader writing/u);
  });

  it.each(["constructor", "toString"])("treats %s as a grader name, not an inherited object member", async (grader) => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      training: { ...training, graders: {}, targets: [{ ...target, grader }] }
    }) });
    await expect(createTrainingPlan(root, options)).rejects.toThrow(`agent:writer references unknown grader ${grader}`);
    await writeTrainingFile(root, "Spawnfile", agentManifest({
      training: { ...training, graders: { [grader]: "training/writing.grader.yaml" }, targets: [{ ...target, grader }] }
    }));
    expect((await createTrainingPlan(root, options)).graders[0].name).toBe(grader);
  });

  it("includes team targets only for agents consuming at least one of their files", async () => {
    const files = teamFiles();
    const root = await trainingProject({ ...files, "b/Spawnfile": agentManifest({ name: "b", training: undefined,
      workspace: { docs: { system: "AGENTS.md", soul: "AGENTS.md" } }
    }) });
    const a = await createTrainingPlan(root, { ...options, agent: "agent:a" });
    expect(a.targets[0].files[0].consumers).toEqual(["agent:a"]);
    expect((await createTrainingPlan(root, { ...options, agent: "agent:b" })).targets).toEqual([]);
  });
});
