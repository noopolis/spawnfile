import type { CompilePlan, ResolvedTeamNode } from "./types.js";
import {
  assertOrganizationSegment,
  compareOrganizationIds,
  freezeOrganizationIdentity,
  MAX_EXTERNAL_PARTICIPANTS,
  MAX_ORGANIZATION_AGENT_MEMBERS,
  MAX_ORGANIZATION_MEMBER_DEPTH,
  MAX_ORGANIZATION_MEMBER_ID_BYTES,
  ORGANIZATION_MEMBER_ID_PATTERN_SOURCE,
  organizationAgentPaths,
  organizationIdentityFail,
  rootOrganizationTeam,
} from "./organizationIdentityGraph.js";

export {
  MAX_EXTERNAL_PARTICIPANTS,
  MAX_ORGANIZATION_AGENT_MEMBERS,
  MAX_ORGANIZATION_MEMBER_DEPTH,
  MAX_ORGANIZATION_MEMBER_ID_BYTES,
  ORGANIZATION_ID_SEGMENT_PATTERN_SOURCE,
  ORGANIZATION_MEMBER_ID_PATTERN_SOURCE,
} from "./organizationIdentityGraph.js";
export {
  resolveMoltnetExternalParticipantIntents,
  validateB31MoltnetAuth,
} from "./organizationExternalParticipants.js";

const memberIdPattern = new RegExp(ORGANIZATION_MEMBER_ID_PATTERN_SOURCE, "u");

export interface ResolvedOrganizationAgentMember {
  readonly authoredMemberKey: string;
  readonly kind: "agent";
  readonly memberId: string;
  readonly principalId: string;
}
export interface ResolvedExternalParticipant {
  readonly authoredParticipantKey: string;
  readonly kind: "service";
  readonly memberId: string;
  readonly principalId: string;
}
export interface ResolvedOrganizationIdentity {
  readonly agentMembers: readonly ResolvedOrganizationAgentMember[];
  readonly externalParticipants: readonly ResolvedExternalParticipant[];
}

export const resolveCanonicalAgentMemberId = (
  plan: CompilePlan,
  agentSource: string,
): string | undefined => {
  if (!plan.organizationIdentity) return undefined;
  return organizationAgentPaths(plan).get(agentSource)?.join(".");
};

export const resolveOrganizationIdentity = (
  plan: CompilePlan,
): ResolvedOrganizationIdentity | undefined => {
  const root = rootOrganizationTeam(plan);
  const declaredTeams = plan.nodes.filter((node) => node.kind === "team"
    && ((node.value as ResolvedTeamNode).externalParticipants?.length ?? 0) > 0);
  if (declaredTeams.some((node) => node.value.source !== root?.source)) {
    organizationIdentityFail("external_participants may only be declared on the root team");
  }
  if (!root) return undefined;
  const paths = organizationAgentPaths(plan);
  const agents: ResolvedOrganizationAgentMember[] = [];
  const agentIds = new Set<string>();
  for (const node of plan.nodes.filter((entry) => entry.kind === "agent")) {
    const path = paths.get(node.value.source);
    if (!path) continue;
    if (path.length > MAX_ORGANIZATION_MEMBER_DEPTH) {
      organizationIdentityFail("organization member depth exceeds 8");
    }
    path.forEach((part) => assertOrganizationSegment(part, "organization member slot"));
    const memberId = path.join(".");
    if (!memberIdPattern.test(memberId)
      || Buffer.byteLength(memberId, "ascii") > MAX_ORGANIZATION_MEMBER_ID_BYTES) {
      organizationIdentityFail(`invalid organization member id: ${memberId}`);
    }
    if (agentIds.has(memberId)) organizationIdentityFail(`duplicate organization member id: ${memberId}`);
    agentIds.add(memberId);
    agents.push({ authoredMemberKey: path.at(-1) as string, kind: "agent", memberId, principalId: `agent:${memberId}` });
  }
  if (agents.length > MAX_ORGANIZATION_AGENT_MEMBERS) {
    organizationIdentityFail("organization has too many agent members");
  }
  const seen = new Set<string>();
  const externalParticipants = (root.externalParticipants ?? []).map((service) => {
    assertOrganizationSegment(service.id, "external participant id");
    if (seen.has(service.id)) organizationIdentityFail(`organization member collision: ${service.id}`);
    seen.add(service.id);
    return { authoredParticipantKey: service.id, kind: "service" as const,
      memberId: service.id, principalId: `system:${service.id}` };
  });
  for (const agent of agents) {
    if (seen.has(agent.memberId)) organizationIdentityFail(`organization member collision: ${agent.memberId}`);
  }
  if (externalParticipants.length > MAX_EXTERNAL_PARTICIPANTS) {
    organizationIdentityFail("too many external participants");
  }
  const result = {
    agentMembers: agents.sort((a, b) => compareOrganizationIds(a.memberId, b.memberId)),
    externalParticipants: externalParticipants.sort((a, b) => compareOrganizationIds(a.memberId, b.memberId)),
  };
  return freezeOrganizationIdentity(structuredClone(result));
};
