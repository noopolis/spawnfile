import type { AgentManifest, InlineAgentMember, TeamManifest } from "./schemas.js";

export const materializeInlineAgentManifest = (
  team: TeamManifest,
  member: InlineAgentMember
): AgentManifest => {
  // Inline members cannot declare adapters; the schema already refuses the field.
  const { adapters: _adapters, id, ...agentFields } = member;

  return {
    spawnfile_version: team.spawnfile_version,
    kind: "agent",
    name: id,
    ...agentFields
  };
};
