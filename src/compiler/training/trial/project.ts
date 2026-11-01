import { cp, writeFile } from "node:fs/promises";
import path from "node:path";

import { isAgentManifest, loadManifest, renderSpawnfile } from "../../../manifest/index.js";
import { SpawnfileError } from "../../../shared/index.js";

/** The candidate's instructions become this agent's system document. */
export const TRIAL_INSTRUCTIONS_FILE = "TRAINING_INSTRUCTIONS.md";
const SKIPPED = new Set([".git", "node_modules", ".runtime", ".spawn", ".spawn-dev", ".sim"]);

/**
 * Writes the trial's one-agent organization: a copy of the subject agent's own
 * declaration directory (so every relative doc, skill and resource keeps
 * resolving) whose Spawnfile is the subject's, re-rendered with the candidate
 * prompt as its system document and with every surface (federation), its
 * schedule and its training block removed. Nothing else changes: runtime,
 * engine, model, memory and tools are the subject's.
 */
export const writeTrialProject = async (agentManifestPath: string, instructions: string, directory: string): Promise<string> => {
  const { manifest } = await loadManifest(agentManifestPath);
  if (!isAgentManifest(manifest)) {
    throw new SpawnfileError("validation_error", "A production-booted training subject must be declared in its own agent Spawnfile");
  }
  await cp(path.dirname(agentManifestPath), directory, {
    recursive: true,
    filter: (source) => !SKIPPED.has(path.basename(source))
  });
  const { schedule: _schedule, surfaces: _surfaces, training: _training, ...kept } = manifest;
  const trial = { ...kept, workspace: { ...kept.workspace, docs: { ...kept.workspace?.docs, system: TRIAL_INSTRUCTIONS_FILE } } };
  await writeFile(path.join(directory, TRIAL_INSTRUCTIONS_FILE), instructions);
  const manifestPath = path.join(directory, "Spawnfile");
  await writeFile(manifestPath, renderSpawnfile(trial));
  return manifestPath;
};
