import YAML from "yaml";

import {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "./types.js";

export interface RosterEntry {
  name: string;
  role: "lead" | "member" | "team";
  description: string;
  endpoint: string;
}

export interface Roster {
  team: string;
  mode: "hierarchical" | "swarm";
  lead: string | null;
  self: string;
  external: boolean;
  auth?: {
    mode: "shared_secret";
    secret_env: string;
  };
  members: RosterEntry[];
}

const lookupMemberDescription = (
  nodeSource: string,
  plan: CompilePlan
): string => {
  const node = plan.nodes.find((n) => n.value.source === nodeSource);
  if (!node) {
    return "";
  }
  return (node.value as ResolvedAgentNode | ResolvedTeamNode).description;
};

const buildMemberEndpoint = (memberId: string, routerPort: number): string =>
  `http://localhost:${routerPort}/route/${memberId}/v1/messages`;

/**
 * Generate per-member rosters for a team.
 * Returns a map of member ID -> roster YAML string.
 */
export const generateTeamRosters = (
  teamNode: ResolvedTeamNode,
  plan: CompilePlan,
  routerPort: number
): Map<string, string> => {
  const result = new Map<string, string>();

  const allEntries: Map<string, RosterEntry> = new Map();
  for (const member of teamNode.members) {
    const isLead = member.id === teamNode.lead;
    const role: RosterEntry["role"] = member.kind === "team"
      ? "team"
      : isLead
        ? "lead"
        : "member";

    allEntries.set(member.id, {
      name: member.id,
      role,
      description: lookupMemberDescription(member.nodeSource, plan),
      endpoint: buildMemberEndpoint(member.id, routerPort)
    });
  }

  const auth = teamNode.auth
    ? { mode: "shared_secret" as const, secret_env: teamNode.auth.secret }
    : undefined;

  for (const member of teamNode.members) {
    let visibleMembers: RosterEntry[];

    if (teamNode.mode === "hierarchical") {
      if (member.id === teamNode.lead) {
        // Lead sees all other members
        visibleMembers = [...allEntries.values()].filter(
          (entry) => entry.name !== member.id
        );
      } else {
        // Non-lead members only see the lead
        const leadEntry = teamNode.lead ? allEntries.get(teamNode.lead) : undefined;
        visibleMembers = leadEntry ? [leadEntry] : [];
      }
    } else {
      // Swarm: everyone sees everyone else
      visibleMembers = [...allEntries.values()].filter(
        (entry) => entry.name !== member.id
      );
    }

    const roster: Roster = {
      team: teamNode.name,
      mode: teamNode.mode,
      lead: teamNode.lead,
      self: member.id,
      external: teamNode.external.includes(member.id),
      ...(auth ? { auth } : {}),
      members: visibleMembers
    };

    result.set(member.id, YAML.stringify(roster));
  }

  return result;
};
