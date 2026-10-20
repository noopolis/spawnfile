import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import { SpawnfileError } from "../../shared/index.js";

import { daimonAgentSkillsFromResolved, parseDaimonAgentSkills } from "./grokWorkerSkills.js";

/** The first Daimon whose broker accepts `skillsSha256` and renders `$GROK_HOME/skills` (noopolis/daimon-harness#55). */
export const DAIMON_GROK_SKILLS_MIN_VERSION = "0.2.2";

const runtimesYamlUrl = new URL("../../../runtimes.yaml", import.meta.url);
let pinned: string | undefined;

/**
 * The Daimon package version of the runtime image `runtimes.yaml` pins, from
 * its never-moved `<package version>-<short commit>` tag. Read synchronously
 * because `preflightAgent` (`spawnfile validate`) is synchronous.
 */
export const pinnedDaimonRuntimeVersion = (source?: string): string => {
  if (source === undefined && pinned !== undefined) return pinned;
  const document = parseYaml(source ?? readFileSync(runtimesYamlUrl, "utf8")) as { runtimes?: { daimon?: { install?: { tag?: unknown } } } };
  const tag = document.runtimes?.daimon?.install?.tag;
  const match = typeof tag === "string" ? /^(\d+\.\d+\.\d+)-[0-9a-f]{7,}$/u.exec(tag) : null;
  if (!match) throw new SpawnfileError("runtime_error", `runtimes.yaml pins no versioned Daimon runtime image tag: ${JSON.stringify(tag)}`);
  if (source === undefined) pinned = match[1]!;
  return match[1]!;
};

const below = (version: string, minimum: string): boolean => {
  const left = version.split(".").map(Number), right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index]! < right[index]!;
  return false;
};

/**
 * Why a brokered Grok agent's declared skills cannot compile, or `undefined`.
 *
 * Two causes, both refused before anything is emitted: a skill Daimon's own
 * parser would refuse (a name outside its component rule, a missing
 * `SKILL.md`, a size past `AGENT_SKILLS_BOUNDS`), and a pinned runtime image
 * older than 0.2.2, whose strict service parser rejects the `skillsSha256`
 * key — so the broker, and every Grok agent of the organization, would fail
 * to start.
 */
export const daimonGrokSkillsError = (
  node: ResolvedAgentNode,
  engine: string,
  version: () => string = () => pinnedDaimonRuntimeVersion()
): string | undefined => {
  if (engine !== "grok" || node.skills.length === 0) return undefined;
  try {
    parseDaimonAgentSkills(daimonAgentSkillsFromResolved(node.skills));
  } catch (error) {
    if (error instanceof SpawnfileError) return `Daimon Grok agent ${node.name}: ${error.message}`;
    throw error;
  }
  const pinnedVersion = version();
  if (below(pinnedVersion, DAIMON_GROK_SKILLS_MIN_VERSION)) {
    return `Daimon Grok agent ${node.name} declares skills (${node.skills.map((skill) => skill.name).sort().join(", ")}), but runtimes.yaml pins `
      + `Daimon ${pinnedVersion}, whose engine broker rejects service.json skillsSha256 and would refuse to start every Grok agent of the `
      + `organization. Re-pin the Daimon runtime image to ${DAIMON_GROK_SKILLS_MIN_VERSION} or later, or drop the skills from this agent.`;
  }
  return undefined;
};
