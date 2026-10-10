import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadManifest } from "../../../manifest/index.js";
import { buildCompilePlan } from "../../buildCompilePlan.js";
import { loadTrainingProject } from "./load.js";
import { resolveTrainingPlan } from "./resolve.js";
import { optimizer } from "./fixtures.test-helper.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type Scope = "agent" | "shared" | "inline";
type Surface = "doc" | "skill";
const project = async (scope: Scope, surface: Surface) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-source-")));
  temporaryDirectories.push(directory);
  const file = surface === "doc" ? "AGENTS.md" : "skills/writing/SKILL.md";
  const sourcePath = path.join(directory, file);
  const manifestPath = path.join(directory, "Spawnfile");
  const training = { optimizer, graders: { writing: "writing.grader.yaml" },
    targets: [{ files: [file], grader: "writing", datasets: { train: "train.yaml", test: "test.yaml" } }] };
  const workspace = surface === "doc"
    ? { docs: { system: file } }
    : { docs: { system: "SYSTEM.md" }, skills: [{ ref: "skills/writing" }] };
  const manifest = scope === "agent"
    ? { spawnfile_version: "0.1", kind: "agent", name: "writer", runtime: "openclaw", workspace, training }
    : {
        spawnfile_version: "0.1", kind: "team", name: "newsroom", mode: "swarm",
        ...(scope === "shared" ? { shared: { training } } : {}),
        members: [{ id: "writer", runtime: "openclaw", workspace, ...(scope === "inline" ? { training } : {}) }]
      };
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(path.join(directory, "SYSTEM.md"), "System instructions\n");
  await writeFile(manifestPath, YAML.stringify(manifest));
  return { directory, sourcePath, manifestPath, declaredBy: scope === "shared" ? "team:newsroom" : "agent:writer" };
};

describe.each<Scope>(["agent", "shared", "inline"])("%s training target sources", (scope) => {
  describe.each<Surface>(["doc", "skill"])("consumed %s files", (surface) => {
    it.each(["missing", "directory", "symlink"])("rejects a %s before ordinary source reads with full context", async (kind) => {
      const { directory, sourcePath, manifestPath, declaredBy } = await project(scope, surface);
      if (kind === "directory") await mkdir(sourcePath);
      if (kind === "symlink") {
        const realSource = path.join(directory, "REAL.md");
        await writeFile(realSource, "---\nname: writing\ndescription: Write well.\n---\nInstructions\n");
        await symlink(realSource, sourcePath);
      }
      const error: unknown = await loadTrainingProject(manifestPath).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "validation_error" });
      expect((error as Error).message).toContain(`Training target ${sourcePath} declared by ${declaredBy} (${manifestPath})`);
      expect((error as Error).message).toContain(kind === "symlink" ? "must not be a symlink" : "existing regular .md file");
    });

    it("compiles a regular source without graders or datasets; plan loading requires them", async () => {
      const { sourcePath, manifestPath } = await project(scope, surface);
      await writeFile(sourcePath, "---\nname: writing\ndescription: Write well.\n---\nInstructions\n");
      await expect(loadManifest(manifestPath)).resolves.toMatchObject({ manifestPath });
      await expect(buildCompilePlan(manifestPath)).resolves.toMatchObject({ root: manifestPath });
      await expect(loadTrainingProject(manifestPath)).rejects.toMatchObject({
        code: "validation_error", message: expect.stringContaining("writing.grader.yaml")
      });
    });
  });
});

it("loads a project without training files when no training is declared", async () => {
  const { manifestPath } = await project("agent", "doc");
  await writeFile(manifestPath, YAML.stringify({
    spawnfile_version: "0.1", kind: "agent", name: "writer", runtime: "openclaw"
  }));
  await expect(loadTrainingProject(manifestPath)).resolves.toMatchObject({ targets: [], datasets: {}, graders: {} });
});

it("leaves target ownership and consumption to plan resolution", async () => {
  const { directory } = await project("agent", "doc");
  const file = path.join(directory, "AGENTS.md");
  await writeFile(file, "Instructions\n");
  const manifestPath = path.join(directory, "nested", "Spawnfile");
  await mkdir(path.dirname(manifestPath));
  await writeFile(manifestPath, YAML.stringify({
    spawnfile_version: "0.1", kind: "agent", name: "writer", runtime: "openclaw",
    workspace: { docs: { system: "../AGENTS.md" } },
    training: { targets: [{ files: ["../AGENTS.md"], grader: "writing", datasets: { train: "train.yaml", test: "test.yaml" } }] }
  }));
  const dataset = "examples:\n  - id: sample\n    at: 2026-10-09T08:20:31Z\n    wake: { surface: moltnet, room: news, from: editor, text: write }\n";
  for (const name of ["train.yaml", "test.yaml"]) await writeFile(path.join(directory, "nested", name), dataset);
  const loaded = await loadTrainingProject(manifestPath);
  expect(loaded.targets[0].files[0]).toMatchObject({ sourcePath: file, regular: true });
  expect(() => resolveTrainingPlan(loaded, undefined, "0.1.17")).toThrow(/inside its declaring manifest directory/u);
});

it.each(["member", "subagent"])("checks targets in a referenced %s before compiler source reads", async (kind) => {
  const { directory, sourcePath, manifestPath } = await project("agent", "doc");
  const parent = path.join(directory, "parent");
  await mkdir(parent);
  const references = [{ id: "writer", ref: ".." }];
  await writeFile(path.join(parent, "Spawnfile"), YAML.stringify(kind === "member"
    ? { spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm", members: references }
    : { spawnfile_version: "0.1", kind: "agent", name: "editor", runtime: "openclaw", subagents: references }));
  await expect(loadTrainingProject(parent)).rejects.toMatchObject({
    code: "validation_error",
    message: expect.stringContaining(`Training target ${sourcePath} declared by agent:writer (${manifestPath})`)
  });
});
