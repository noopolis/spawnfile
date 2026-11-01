import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { loadManifest } from "../../../manifest/index.js";
import { compileProject } from "../../compileProject.js";
import { TRIAL_INSTRUCTIONS_FILE, writeTrialProject } from "./project.js";

const fixture = path.resolve(import.meta.dirname, "../../../../fixtures/lifecycle-smoke");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("re-renders the subject agent alone with the candidate prompt, no federation, no schedule, and compiles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-trial-project-")); roots.push(root);
  const manifestPath = await writeTrialProject(path.join(fixture, "agents/watcher/Spawnfile"), "Candidate prompt.", path.join(root, "project"));
  const { manifest } = await loadManifest(manifestPath);
  expect(manifest).toMatchObject({ kind: "agent", name: "watcher", runtime: { name: "daimon", options: { engine: "codex" } },
    workspace: { docs: { system: TRIAL_INSTRUCTIONS_FILE } } });
  expect(manifest).not.toHaveProperty("surfaces");
  expect(manifest).not.toHaveProperty("schedule");
  expect(await readFile(path.join(root, "project", TRIAL_INSTRUCTIONS_FILE), "utf8")).toBe("Candidate prompt.");
  const compiled = await compileProject(manifestPath, { outputDirectory: path.join(root, "out") });
  expect(Object.values(compiled.report.container!.runtime_instances[0]!.engine_by_node_id ?? {})).toEqual(["codex"]);
  expect(compiled.report.container!.ports).toEqual([]);
  expect(compiled.report.container!.moltnet).toBeUndefined();
});

it("refuses a team as a trial subject", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-trial-project-")); roots.push(root);
  await expect(writeTrialProject(path.join(fixture, "Spawnfile"), "x", path.join(root, "project"))).rejects.toThrow("own agent Spawnfile");
});
