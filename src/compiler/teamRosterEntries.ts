import type { DiagnosticReport } from "../report/index.js";

import { resolveTeamRepresentatives } from "./moltnetResolution.js";
import type {
  GenerateTeamRosterOptions,
  RosterEntry,
  RosterRepresentativeEntry
} from "./teamRosterTypes.js";
import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedAgentSurfaces,
  ResolvedMemberRef,
  ResolvedTeamNode
} from "./types.js";

const SURFACE_ORDER = ["moltnet", "slack", "discord", "telegram", "whatsapp"];

const findNode = (
  plan: CompilePlan,
  source: string
): ResolvedAgentNode | ResolvedTeamNode | null =>
  plan.nodes.find((node) => node.value.source === source)?.value ?? null;

const findAgent = (
  plan: CompilePlan,
  source: string
): ResolvedAgentNode | null => {
  const node = findNode(plan, source);
  return node?.kind === "agent" ? node : null;
};

const findTeam = (
  plan: CompilePlan,
  source: string
): ResolvedTeamNode | null => {
  const node = findNode(plan, source);
  return node?.kind === "team" ? node : null;
};

const lookupDescription = (source: string, plan: CompilePlan): string =>
  findNode(plan, source)?.description ?? "";

const getContextRoomIds = (
  contextTeamSource: string,
  attachment: NonNullable<ResolvedAgentSurfaces["moltnet"]>[number]
): string[] => {
  const contextRooms = attachment.contextRooms?.[contextTeamSource];
  if (contextRooms) {
    return [...contextRooms].sort();
  }

  if (attachment.teamSource === contextTeamSource) {
    return Object.keys(attachment.rooms ?? {}).sort();
  }

  return [];
};

const createMoltnetAddresses = (
  agent: ResolvedAgentNode,
  contextTeamSource: string,
  memberId: string
): Record<string, { fqid: string; rooms: string[] }> => {
  const addresses: Record<string, { fqid: string; rooms: string[] }> = {};

  for (const attachment of agent.surfaces?.moltnet ?? []) {
    if (attachment.memberId !== memberId) {
      continue;
    }

    const rooms = getContextRoomIds(contextTeamSource, attachment);
    if (rooms.length === 0 && attachment.teamSource !== contextTeamSource) {
      continue;
    }

    addresses[attachment.network] = {
      fqid: `molt://${attachment.network}/agents/${memberId}`,
      rooms
    };
  }

  return addresses;
};

const createIdentityAddresses = (
  surfaces: ResolvedAgentSurfaces | undefined
): Record<string, unknown> => ({
  ...(surfaces?.slack?.identity
    ? { slack: { user_id: surfaces.slack.identity.userId } }
    : {}),
  ...(surfaces?.discord?.identity
    ? { discord: { user_id: surfaces.discord.identity.userId } }
    : {}),
  ...(surfaces?.telegram?.identity
    ? {
        telegram: {
          ...(surfaces.telegram.identity.userId
            ? { user_id: surfaces.telegram.identity.userId }
            : {}),
          ...(surfaces.telegram.identity.username
            ? { username: surfaces.telegram.identity.username }
            : {})
        }
      }
    : {}),
  ...(surfaces?.whatsapp?.identity
    ? { whatsapp: { phone: surfaces.whatsapp.identity.phone } }
    : {})
});

const createConcreteEntry = (
  plan: CompilePlan,
  agentSource: string,
  memberId: string,
  role: "lead" | "member",
  contextTeamSource: string,
  delegateRole?: "lead" | "representative"
): RosterRepresentativeEntry & { role: "lead" | "member" } => {
  const agent = findAgent(plan, agentSource);
  const moltnet = agent
    ? createMoltnetAddresses(agent, contextTeamSource, memberId)
    : {};
  const identity = createIdentityAddresses(agent?.surfaces);
  const addresses = {
    ...identity,
    ...(Object.keys(moltnet).length > 0 ? { moltnet } : {})
  };
  const surfaces = SURFACE_ORDER.filter((surface) => {
    if (surface === "moltnet") {
      return Object.keys(moltnet).length > 0;
    }
    return Boolean(agent?.surfaces?.[surface as keyof ResolvedAgentSurfaces]);
  });

  return {
    addresses,
    ...(delegateRole ? { delegate_role: delegateRole } : {}),
    description: agent?.description ?? "",
    role,
    surfaces
  };
};

const createCardPath = (contextKey: string, memberId: string): string =>
  `.spawnfile/team-cards/${contextKey}/${memberId}.md`;

const createTeamEntry = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode,
  member: ResolvedMemberRef,
  contextKey: string,
  contextTeamSource: string
): RosterEntry => {
  const childTeam = findTeam(plan, member.nodeSource);
  const representatives = childTeam
    ? resolveTeamRepresentatives(plan, childTeam)
    : [];
  const isLead = member.id === teamNode.lead;
  const delegateRole = isLead ? "lead" : "representative";

  return {
    addresses: {},
    card: {
      path: createCardPath(contextKey, member.id),
      summary: lookupDescription(member.nodeSource, plan)
    },
    description: lookupDescription(member.nodeSource, plan),
    ...(isLead ? { is_lead: true } : {}),
    representatives: Object.fromEntries(
      representatives.map((representative) => {
        const entry = createConcreteEntry(
          plan,
          representative.agentSource,
          representative.memberId,
          delegateRole === "lead" ? "lead" : "member",
          contextTeamSource,
          delegateRole
        );
        const { role: _role, ...representativeEntry } = entry;
        return [representative.memberId, representativeEntry];
      })
    ),
    role: "team",
    surfaces: []
  };
};

export const getVisibleTeamMembers = (
  teamNode: ResolvedTeamNode,
  selfMemberId: string,
  delegateRole?: "lead" | "representative",
  representedSlotId?: string
): ResolvedMemberRef[] => {
  const excluded = representedSlotId ?? selfMemberId;
  if (teamNode.mode === "swarm") {
    return teamNode.members.filter((member) => member.id !== excluded);
  }

  const hasLeadVisibility = selfMemberId === teamNode.lead || delegateRole === "lead";
  if (hasLeadVisibility) {
    return teamNode.members.filter((member) => member.id !== excluded);
  }

  const lead = teamNode.lead
    ? teamNode.members.find((member) => member.id === teamNode.lead)
    : undefined;
  return lead && lead.id !== excluded ? [lead] : [];
};

export const createRosterEntry = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode,
  member: ResolvedMemberRef,
  options: GenerateTeamRosterOptions
): RosterEntry => {
  if (member.kind === "team") {
    return createTeamEntry(plan, teamNode, member, options.contextKey, options.teamSource);
  }

  return createConcreteEntry(
    plan,
    member.nodeSource,
    member.id,
    member.id === teamNode.lead ? "lead" : "member",
    options.teamSource
  );
};

export const collectConcreteParticipants = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode,
  selfMemberId: string,
  visibleMembers: ResolvedMemberRef[],
  representedSlotId?: string
): Array<{ agentSource: string; id: string }> => {
  const selfMember = representedSlotId
    ? null
    : teamNode.members.find((member) => member.id === selfMemberId && member.kind === "agent");
  const participants: Array<{ agentSource: string; id: string }> = selfMember
    ? [{ agentSource: selfMember.nodeSource, id: selfMember.id }]
    : [];

  if (representedSlotId) {
    const representedMember = teamNode.members.find((member) => member.id === representedSlotId);
    if (representedMember?.kind === "team") {
      const childTeam = findTeam(plan, representedMember.nodeSource);
      const representative = childTeam
        ? resolveTeamRepresentatives(plan, childTeam).find((entry) => entry.memberId === selfMemberId)
        : undefined;
      if (representative) {
        participants.push({
          agentSource: representative.agentSource,
          id: representative.memberId
        });
      }
    }
  }

  for (const member of visibleMembers) {
    if (member.kind === "agent") {
      participants.push({ agentSource: member.nodeSource, id: member.id });
      continue;
    }

    const childTeam = findTeam(plan, member.nodeSource);
    if (!childTeam) {
      continue;
    }
    for (const representative of resolveTeamRepresentatives(plan, childTeam)) {
      participants.push({
        agentSource: representative.agentSource,
        id: representative.memberId
      });
    }
  }

  return participants;
};

const getCoordinationBindings = (
  plan: CompilePlan,
  participant: { agentSource: string; id: string },
  contextTeamSource: string
): string[] => {
  const agent = findAgent(plan, participant.agentSource);
  if (!agent) {
    return [];
  }

  const bindings = new Set<string>();
  for (const surface of ["slack", "discord", "telegram", "whatsapp"] as const) {
    if (agent.surfaces?.[surface]) {
      bindings.add(surface);
    }
  }

  for (const attachment of agent.surfaces?.moltnet ?? []) {
    if (attachment.memberId !== participant.id) {
      continue;
    }
    for (const roomId of getContextRoomIds(contextTeamSource, attachment)) {
      bindings.add(`moltnet:${attachment.network}:${roomId}`);
    }
  }

  return [...bindings].sort();
};

export const createCoordinationDiagnostics = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode,
  participants: Array<{ agentSource: string; id: string }>,
  contextTeamSource: string
): DiagnosticReport[] => {
  if (participants.length <= 1) {
    return [];
  }

  const bindingsByParticipant = new Map(
    participants.map((participant) => [
      participant.id,
      getCoordinationBindings(plan, participant, contextTeamSource)
    ])
  );
  const connected = new Set<string>();
  let edgeCount = 0;

  for (let index = 0; index < participants.length; index += 1) {
    for (let other = index + 1; other < participants.length; other += 1) {
      const left = participants[index]!;
      const right = participants[other]!;
      const leftBindings = new Set(bindingsByParticipant.get(left.id) ?? []);
      const hasSharedBinding = (bindingsByParticipant.get(right.id) ?? []).some((binding) =>
        leftBindings.has(binding)
      );
      if (hasSharedBinding) {
        edgeCount += 1;
        connected.add(left.id);
        connected.add(right.id);
      }
    }
  }

  return [
    ...(edgeCount === 0
      ? [{
          level: "warn" as const,
          message: `Team ${teamNode.name} context has no shared coordination surface between visible participants`
        }]
      : []),
    ...participants
      .filter((participant) => !connected.has(participant.id))
      .map((participant) => ({
        level: "warn" as const,
        message: `Team ${teamNode.name} member ${participant.id} has no shared coordination surface with any visible teammate`
      }))
  ];
};
