import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getManifestPath, resolveProjectPath } from "../../../filesystem/index.js";
import { isAgentManifest, isReferencedMember, loadManifest, type Manifest } from "../../../manifest/index.js";
import { SpawnfileError } from "../../../shared/index.js";

/** The candidate's instructions become this agent's system document. */
export const TRIAL_INSTRUCTIONS_FILE = "TRAINING_INSTRUCTIONS.md";

/** What a trial compiles: the project's own root manifest, with these manifests replaced in memory. */
export interface TrialProject {
  manifestPath: string;
  manifestOverrides: ReadonlyMap<string, Manifest>;
}

const fail = (message: string): never => { throw new SpawnfileError("validation_error", message); };

/** The member chain from a team down to the subject's manifest, by referenced members. */
const chainTo = async (teamPath: string, subjectPath: string, seen = new Set<string>()): Promise<{ manifestPath: string; manifest: Manifest; memberId?: string }[] | null> => {
  if (seen.has(teamPath)) return null;
  seen.add(teamPath);
  const { manifest } = await loadManifest(teamPath);
  if (teamPath === subjectPath) return [{ manifestPath: teamPath, manifest }];
  if (isAgentManifest(manifest)) return null;
  for (const member of manifest.members ?? []) {
    if (!isReferencedMember(member)) continue;
    const childPath = getManifestPath(resolveProjectPath(teamPath, member.ref));
    const below = await chainTo(childPath, subjectPath, seen);
    if (below) return [{ manifestPath: teamPath, manifest, memberId: member.id }, ...below];
  }
  return null;
};

/**
 * The trial's organization is the subject's own project, compiled from its own files so every team
 * inheritance (shared environment, MCP servers, workspace resources, docs) and every relative path holds,
 * with two manifests replaced in memory: each team on the way down keeps only the member leading to the
 * subject and no networks or external participants; the subject loses its surfaces (federation), schedule
 * and training block and takes the candidate prompt as its system document. Nothing else changes.
 */
export const writeTrialProject = async (
  projectManifestPath: string, agentManifestPath: string, instructions: string, directory: string
): Promise<TrialProject> => {
  const root = path.resolve(projectManifestPath), subject = path.resolve(agentManifestPath);
  const chain = await chainTo(root, subject)
    ?? fail(`Training subject ${subject} is not a referenced member of ${root}`);
  const agent = chain.at(-1)!.manifest;
  if (!isAgentManifest(agent)) return fail("A production-booted training subject must be declared in its own agent Spawnfile");
  await mkdir(directory, { recursive: true });
  const instructionsPath = path.join(directory, TRIAL_INSTRUCTIONS_FILE);
  await writeFile(instructionsPath, instructions);
  const overrides = new Map<string, Manifest>();
  for (const link of chain.slice(0, -1)) {
    if (isAgentManifest(link.manifest)) continue;
    const { networks: _networks, external_participants: _participants, ...team } = link.manifest;
    overrides.set(link.manifestPath, {
      ...team, members: (team.members ?? []).filter((member) => member.id === link.memberId),
      ...(team.lead === undefined ? {} : { lead: link.memberId! })
    } as Manifest);
  }
  const { schedule: _schedule, surfaces: _surfaces, training: _training, ...kept } = agent;
  const system = path.relative(path.dirname(subject), instructionsPath).split(path.sep).join("/");
  overrides.set(subject, { ...kept, workspace: { ...kept.workspace, docs: { ...kept.workspace?.docs, system } } } as Manifest);
  return { manifestPath: root, manifestOverrides: overrides };
};
