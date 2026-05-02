import { SpawnfileError } from "../shared/index.js";

import type {
  CompilePlan,
  ResolvedMoltnetAttachment,
  ResolvedTeamNetwork,
  ResolvedTeamNode
} from "./types.js";

export interface MoltnetTeamContext {
  memberId: string;
  teamName: string;
  teamSource: string;
  networks: ResolvedTeamNetwork[];
}

export interface TeamRepresentativeResolution {
  agentSource: string;
  memberId: string;
  path: string[];
  sourceTeamName: string;
  sourceTeamSource: string;
}

const cloneAttachment = (
  attachment: ResolvedMoltnetAttachment,
  context: MoltnetTeamContext
): ResolvedMoltnetAttachment => ({
  ...(attachment.dms ? { dms: { ...attachment.dms } } : {}),
  memberId: context.memberId,
  network: attachment.network,
  ...(attachment.rooms
    ? {
        rooms: Object.fromEntries(
          Object.entries(attachment.rooms).map(([roomId, policy]) => [
            roomId,
            { ...policy }
          ])
        )
      }
    : {}),
  teamSource: context.teamSource
});

const findTeamBySource = (
  plan: CompilePlan,
  source: string
): ResolvedTeamNode => {
  const node = plan.nodes.find((entry) => entry.kind === "team" && entry.value.source === source);
  if (!node || node.value.kind !== "team") {
    throw new SpawnfileError(
      "compile_error",
      `Unable to find team node at ${source}`
    );
  }

  return node.value;
};

export const resolveTeamRepresentatives = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode,
  seen: string[] = []
): TeamRepresentativeResolution[] => {
  if (seen.includes(teamNode.source)) {
    throw new SpawnfileError(
      "compile_error",
      `Cycle detected while resolving representatives for ${teamNode.name}`
    );
  }

  const selectedMemberIds = teamNode.externalExplicit
    ? teamNode.external
    : teamNode.mode === "hierarchical" && teamNode.lead
      ? [teamNode.lead]
      : teamNode.members.map((member) => member.id);

  const nextSeen = [...seen, teamNode.source];
  const representatives: TeamRepresentativeResolution[] = [];

  for (const memberId of selectedMemberIds) {
    const member = teamNode.members.find((entry) => entry.id === memberId);
    if (!member) {
      throw new SpawnfileError(
        "validation_error",
        `Team ${teamNode.name} representative interface references unknown member ${memberId}`
      );
    }

    if (member.kind === "agent") {
      representatives.push({
        agentSource: member.nodeSource,
        memberId: member.id,
        path: [member.id],
        sourceTeamName: teamNode.name,
        sourceTeamSource: teamNode.source
      });
      continue;
    }

    const childTeam = findTeamBySource(plan, member.nodeSource);
    const childRepresentatives = resolveTeamRepresentatives(plan, childTeam, nextSeen);
    if (childRepresentatives.length === 0) {
      throw new SpawnfileError(
        "validation_error",
        `Team ${childTeam.name} does not resolve to a concrete representative for ${teamNode.name}`
      );
    }

    for (const representative of childRepresentatives) {
      representatives.push({
        ...representative,
        path: [member.id, ...representative.path]
      });
    }
  }

  return representatives;
};

export const resolveMoltnetAttachments = (
  attachments: ResolvedMoltnetAttachment[] | undefined,
  context: MoltnetTeamContext | undefined,
  nodeName: string
): ResolvedMoltnetAttachment[] | undefined => {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  if (!context) {
    throw new SpawnfileError(
      "validation_error",
      `Agent ${nodeName} declares Moltnet surfaces but is not attached to a team network`
    );
  }

  return attachments.map((attachment) => {
    const network = context.networks.find((entry) => entry.id === attachment.network);
    if (!network) {
      throw new SpawnfileError(
        "validation_error",
        `Agent ${nodeName} references unknown Moltnet network ${attachment.network} on team ${context.teamName}`
      );
    }

    for (const roomId of Object.keys(attachment.rooms ?? {})) {
      const room = network.rooms.find((entry) => entry.id === roomId);
      if (!room) {
        throw new SpawnfileError(
          "validation_error",
          `Agent ${nodeName} references unknown Moltnet room ${roomId} on network ${network.id}`
        );
      }

      if (!room.members.includes(context.memberId)) {
        throw new SpawnfileError(
          "validation_error",
          `Agent ${nodeName} cannot attach to Moltnet room ${roomId} because member ${context.memberId} is not in that room`
        );
      }
    }

    return cloneAttachment(attachment, context);
  });
};
