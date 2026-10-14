import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { createTrainingContext } from "../context.js";
import { lowerTrainingExecution, mapTrainingExecution } from "../execution.js";
import { loadTrainingProject, resolveTrainingPlan } from "../plan/index.js";
import { cleanTrainingProjects } from "../plan/fixtures.test-helper.js";
import { activateTrainingExecution } from "./activation.js";
import { activationFixture } from "./activation.test-helper.js";

afterEach(cleanTrainingProjects);

it("compiles a nested org against its declared enclosing repository with sibling bundle files and Git identity", async () => {
  const f = await activationFixture();
  const repository = path.join(f.root, "repository"), org = path.join(repository, "org");
  await mkdir(repository); await rename(f.projectRoot, org);
  await writeFile(path.join(repository, "sibling.txt"), "Enclosing repository bytes.\n");
  const manifest = parse(await readFile(path.join(org, "Spawnfile"), "utf8"));
  manifest.workspace = { docs: { system: "AGENTS.md" }, resources: [{
    id: "repository", kind: "bundle", mount: "./repository", mode: "readonly",
    build: { files: { root: "..", exclude: ["org/history", "org/training", "**/Spawnfile"] } }
  }] };
  await writeFile(path.join(org, "Spawnfile"), JSON.stringify(manifest));
  const declarationFile = path.join(org, "training/container.json");
  const declaration = JSON.parse(await readFile(declarationFile, "utf8"));
  declaration.inputs[0].source = "../..";
  await writeFile(declarationFile, JSON.stringify(declaration));
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet"); git("add", ".");
  const revision = execFileSync("git", ["-C", repository, "commit-tree", git("write-tree"), "-m", "fixture"], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-10-06T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-06T00:00:00Z" }
  }).trim();
  git("update-ref", "HEAD", revision);
  manifest.workspace.resources[0].build.files.ref = revision;
  await writeFile(path.join(org, "Spawnfile"), JSON.stringify(manifest));
  const project = await loadTrainingProject(org), plan = resolveTrainingPlan(project, "writer", "test");
  const execution = (await lowerTrainingExecution({ project, plan, args: ["--out", f.execution.output] })).execution;
  expect(execution.sourceRoot, "declared enclosing source guarantee").toBe(repository);
  expect(mapTrainingExecution(execution, file => file.replace(repository, "/run/training/inputs/repository")).sourceRoot,
    "mapped enclosing source guarantee").toBe("/run/training/inputs/repository");
  const context = await createTrainingContext(org, { packageVersion: "test" });
  const activated = await activateTrainingExecution({ execution, context, prepareCase: f.prepareCase });
  let result;
  try {
    result = await activated.operations.compileTrainingCandidate({ context, resources: [{ sourcePath: "AGENTS.md",
      sourceContent: "Write precisely.\n", content: "Use sibling evidence.\n", edit: "editable" }], out: path.join(f.root, "candidate") });
  } catch (error) { expect.fail(`activation enclosing source guarantee: ${String(error)}`); }
  expect((await readdir(path.join(f.root, "candidate/bundle-cache")).catch(() => [] )).length,
    "activation enclosing source guarantee: evaluator bundle cache").toBeGreaterThan(0);
  const snapshot = path.dirname(result!.projectRoot);
  expect(await readFile(path.join(snapshot, "sibling.txt"), "utf8"), "activation enclosing source guarantee").toBe("Enclosing repository bytes.\n");
  expect(execFileSync("git", ["-C", snapshot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(revision);
  const bundles = path.join(result!.compiledRoot, "container/workspace-bundles");
  const tar = (await readdir(bundles)).find(name => name.endsWith(".tar"))!;
  const contents = execFileSync("tar", ["-xOf", path.join(bundles, tar), "sibling.txt"], { encoding: "utf8" });
  expect(contents).toBe("Enclosing repository bytes.\n");
  expect(await readFile(path.join(org, "AGENTS.md"), "utf8")).toBe("Write precisely.\n");
});

it("refuses an absent or non-enclosing session source root before case authoring", async () => {
  const f = await activationFixture();
  for (const sourceRoot of [undefined, f.execution.output]) {
    await expect(activateTrainingExecution({ ...f, execution: { ...f.execution, sourceRoot } })).rejects.toThrow("enclosing source root");
  }
});

it("binds the enclosing root to exact resume identity", async () => {
  const f = await activationFixture();
  await activateTrainingExecution(f);
  const attempt = await activateTrainingExecution({ ...f, execution: { ...f.execution,
    sourceRoot: f.root, args: [...f.execution.args, "--resume"] } }).catch((error: unknown) => error);
  expect(attempt, "activation source root resume guarantee").toBeInstanceOf(Error);
  expect((attempt as Error).message, "activation source root resume guarantee").toContain("immutable activation receipt");
});
