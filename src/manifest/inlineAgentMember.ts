import type { AgentManifest, InlineAgentMember, TeamManifest } from "./schemas.js";

export const materializeInlineAgentManifest = (
  team: TeamManifest,
  member: InlineAgentMember
): AgentManifest => {
  const { id, ...agentFields } = member;

  return {
    spawnfile_version: team.spawnfile_version,
    kind: "agent",
    name: id,
    ...agentFields
  };
};
