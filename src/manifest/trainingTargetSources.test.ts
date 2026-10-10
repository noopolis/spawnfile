import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadManifest } from "./loadManifest.js";
import { manifestSchema } from "./schemas.js";
import { validateTrainingTargetSources } from "./trainingTargetSources.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type Scope = "agent" | "shared" | "inline";
type Surface = "doc" | "skill";
const project = async (scope: Scope, surface: Surface) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-source-"));
  temporaryDirectories.push(directory);
  const file = surface === "doc" ? "AGENTS.md" : "skills/writing/SKILL.md";
  const sourcePath = path.join(directory, file);
  const manifestPath = path.join(directory, "Spawnfile");
  const training = { targets: [{ files: [file], grader: "writing", datasets: { train: "train.yaml", test: "test.yaml" } }] };
  const workspace = surface === "doc"
    ? { docs: { system: file } }
    : { docs: { system: "SYSTEM.md" }, skills: [{ ref: "skills/writing" }] };
  const manifest = scope === "agent"
    ? { spawnfile_version: "0.1", kind: "agent", name: "writer", workspace, training }
    : {
        spawnfile_version: "0.1", kind: "team", name: "newsroom", mode: "swarm",
        ...(scope === "shared" ? { shared: { training } } : {}),
        members: [{ id: "writer", workspace, ...(scope === "inline" ? { training } : {}) }]
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
      const error: unknown = await loadManifest(manifestPath).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "validation_error" });
      expect((error as Error).message).toContain(`Training target ${sourcePath} declared by ${declaredBy} (${manifestPath})`);
      expect((error as Error).message).toContain(kind === "symlink" ? "must not be a symlink" : "existing regular .md file");
    });

    it("accepts a regular source without loading graders or datasets", async () => {
      const { sourcePath, manifestPath } = await project(scope, surface);
      await writeFile(sourcePath, "---\nname: writing\ndescription: Write well.\n---\nInstructions\n");
      await expect(loadManifest(manifestPath)).resolves.toMatchObject({ manifestPath });
    });
  });
});

it("performs no file checks for a manifest without targets", async () => {
  const manifest = manifestSchema.parse({ spawnfile_version: "0.1", kind: "agent", name: "writer" });
  await expect(validateTrainingTargetSources("/does-not-exist/Spawnfile", manifest)).resolves.toBeUndefined();
});

it("leaves target ownership and consumption to plan resolution", async () => {
  const { directory, manifestPath } = await project("agent", "doc");
  const file = path.join(directory, "AGENTS.md");
  await writeFile(file, "Instructions\n");
  const manifest = manifestSchema.parse({
    spawnfile_version: "0.1", kind: "agent", name: "writer",
    training: { targets: [{ files: ["../AGENTS.md"], grader: "writing", datasets: { train: "train.yaml", test: "test.yaml" } }] }
  });
  await expect(validateTrainingTargetSources(path.join(directory, "nested", "Spawnfile"), manifest)).resolves.toBeUndefined();
  await expect(loadManifest(manifestPath)).resolves.toMatchObject({ manifestPath });
});
