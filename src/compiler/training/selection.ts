import { SpawnfileError } from "../../shared/index.js";

/** Exact IDs win; a short authored name must identify exactly one graph node. */
export const selectTrainingAgent = <T extends { id: string; value: { name: string } }>(
  agents: readonly T[], selector: string | undefined
): T => {
  const exact = agents.find(agent => agent.id === selector);
  if (exact) return exact;
  const matches = selector === undefined ? agents : selector.includes(":") ? []
    : agents.filter(agent => agent.value.name === selector || agent.id.slice("agent:".length) === selector);
  if (matches.length === 1) return matches[0]!;
  throw new SpawnfileError("validation_error", selector === undefined
    ? "Training requires --agent when the project does not contain exactly one agent"
    : matches.length > 1 ? `Ambiguous training agent ${selector}; use an exact node id: ${matches.map(agent => agent.id).sort().join(", ")}`
      : `No canonical agent matches ${selector}`);
};
