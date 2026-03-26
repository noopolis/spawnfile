import { SpawnfileError } from "../shared/index.js";

import { stableStringify } from "./helpers.js";
import type { ResolvedAgentNode, ResolvedSkill, ResolvedTeamNode } from "./types.js";

export const getMcpNames = (servers: Array<{ name: string }>): Set<string> =>
  new Set(servers.map((server) => server.name));

export const validateEffectiveSkillRequirements = (
  nodeName: string,
  mcpNames: Set<string>,
  skills: ResolvedSkill[]
): void => {
  for (const skill of skills) {
    for (const mcpName of skill.requiresMcp) {
      if (!mcpNames.has(mcpName)) {
        throw new SpawnfileError(
          "validation_error",
          `Skill ${skill.name} on ${nodeName} requires undeclared MCP server: ${mcpName}`
        );
      }
    }
  }
};

export const getAgentFingerprint = (node: ResolvedAgentNode): string =>
  stableStringify({
    env: node.env,
    execution: node.execution,
    mcpServers: node.mcpServers,
    runtime: node.runtime,
    secrets: node.secrets,
    skills: node.skills.map((skill) => ({
      name: skill.name,
      ref: skill.ref,
      requiresMcp: skill.requiresMcp
    })),
    surfaces: node.surfaces
  });

export const getTeamFingerprint = (node: ResolvedTeamNode): string =>
  stableStringify({
    members: node.members,
    structure: node.structure,
    shared: {
      env: node.shared.env,
      mcpServers: node.shared.mcpServers,
      secrets: node.shared.secrets,
      skills: node.shared.skills.map((skill) => ({
        name: skill.name,
        ref: skill.ref,
        requiresMcp: skill.requiresMcp
      }))
    }
  });
