import { SpawnfileError } from "../shared/index.js";

import { resolveTeamRepresentatives } from "./moltnetRepresentativeResolution.js";
import { resolveCanonicalAgentMemberId } from "./organizationIdentity.js";
import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedMoltnetRoomMembership,
  ResolvedMoltnetRoomPolicy,
  ResolvedTeamNetworkRoom,
  ResolvedTeamNode
} from "./types.js";
import { isDeclaredPairedRemoteRoomMember } from "../manifest/index.js";

import { isAttachedExternalRoomMember } from "./buildCompilePlanTeams.js";

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const findAgentBySource = (
  plan: CompilePlan,
  source: string
): ResolvedAgentNode => {
  const node = plan.nodes.find((entry) => entry.kind === "agent" && entry.value.source === source);
  if (!node || node.value.kind !== "agent") {
    throw new SpawnfileError(
      "compile_error",
      `Unable to find agent node at ${source}`
    );
  }

  return node.value;
};

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

const clonePolicy = (
  policy: ResolvedMoltnetRoomPolicy
): ResolvedMoltnetRoomPolicy => ({
  ...(policy.wake ? { wake: policy.wake } : {})
});

const defaultNestedRepresentativePolicy = (): ResolvedMoltnetRoomPolicy => ({
  wake: "mentions"
});

// Ordinary Moltnet uses direct member slots. B31's externally authorized
// organization uses its canonical nested principal identifiers instead.
const resolveConcreteMemberId = (
  plan: CompilePlan,
  agentSource: string,
  authoredMemberId: string
): string => {
  if ((plan.organizationIdentity?.externalParticipants.length ?? 0) === 0) {
    return authoredMemberId;
  }
  const canonicalMemberId = resolveCanonicalAgentMemberId(plan, agentSource);
  if (!canonicalMemberId) {
    throw new SpawnfileError(
      "validation_error",
      `Unable to resolve canonical Moltnet member id for ${agentSource}`
    );
  }
  return canonicalMemberId;
};

const findDirectRoomPolicy = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode,
  agentSource: string,
  memberId: string,
  networkId: string,
  roomId: string
): ResolvedMoltnetRoomPolicy | undefined => {
  const agentNode = findAgentBySource(plan, agentSource);

  for (const attachment of agentNode.surfaces?.moltnet ?? []) {
    if (attachment.network !== networkId) {
      continue;
    }
    if (attachment.teamSource && attachment.teamSource !== teamNode.source) {
      continue;
    }
    if (attachment.memberId && attachment.memberId !== memberId) {
      continue;
    }
    if (!attachment.rooms || !hasOwn(attachment.rooms, roomId)) {
      continue;
    }

    return clonePolicy(attachment.rooms[roomId] ?? {});
  }

  return undefined;
};

const compareRoomMemberships = (
  left: ResolvedMoltnetRoomMembership,
  right: ResolvedMoltnetRoomMembership
): number =>
  [
    left.declaringTeamSource.localeCompare(right.declaringTeamSource),
    left.networkId.localeCompare(right.networkId),
    left.roomId.localeCompare(right.roomId),
    left.declaredSlot.localeCompare(right.declaredSlot),
    (left.representativePath ?? []).join("/").localeCompare(
      (right.representativePath ?? []).join("/")
    ),
    left.concreteMemberId.localeCompare(right.concreteMemberId),
    left.agentSource.localeCompare(right.agentSource)
  ].find((result) => result !== 0) ?? 0;

export const listConcreteMoltnetRoomMemberIds = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode,
  networkId: string,
  room: ResolvedTeamNetworkRoom,
  memberships = plan.moltnetRoomMemberships
): string[] => {
  const network = teamNode.networks?.find((candidate) => candidate.id === networkId);
  const externalMembers = room.members.filter((memberId) =>
    isAttachedExternalRoomMember(teamNode, networkId, memberId));
  const remoteMembers = network
    ? room.members.filter((memberId) => isDeclaredPairedRemoteRoomMember(network, room, memberId))
    : [];
  if (memberships) {
    return [
      ...new Set(
        [
          ...memberships
          .filter((membership) =>
            membership.declaringTeamSource === teamNode.source
            && membership.networkId === networkId
            && membership.roomId === room.id
          )
          .map((membership) => membership.concreteMemberId),
          ...externalMembers,
          ...remoteMembers
        ]
      )
    ].sort();
  }

  const concreteMembers: string[] = [];
  for (const declaredSlot of room.members) {
    const member = teamNode.members.find((entry) => entry.id === declaredSlot);
    if (!member) {
      if (isAttachedExternalRoomMember(teamNode, networkId, declaredSlot)) {
        concreteMembers.push(declaredSlot);
        continue;
      }
      if (network && isDeclaredPairedRemoteRoomMember(network, room, declaredSlot)) {
        concreteMembers.push(declaredSlot);
        continue;
      }
      throw new SpawnfileError(
        "validation_error",
        `Team ${teamNode.name} Moltnet room ${room.id} references unknown member ${declaredSlot}`
      );
    }

    if (member.kind === "agent") {
      concreteMembers.push(resolveConcreteMemberId(plan, member.nodeSource, member.id));
      continue;
    }

    const childTeam = findTeamBySource(plan, member.nodeSource);
    const representatives = resolveTeamRepresentatives(plan, childTeam);
    if (representatives.length === 0) {
      throw new SpawnfileError(
        "validation_error",
        `Team ${childTeam.name} has no concrete representative for Moltnet room ${room.id} on ${teamNode.name}`
      );
    }
    concreteMembers.push(...representatives.map((representative) =>
      resolveConcreteMemberId(plan, representative.agentSource, representative.memberId)
    ));
  }

  return [...new Set(concreteMembers)].sort();
};

export const resolveMoltnetRoomMemberships = (
  plan: CompilePlan
): ResolvedMoltnetRoomMembership[] => {
  const memberships: ResolvedMoltnetRoomMembership[] = [];

  for (const node of plan.nodes) {
    if (node.value.kind !== "team") {
      continue;
    }

    const teamNode = node.value;
    for (const network of teamNode.networks ?? []) {
      for (const room of network.rooms) {
        for (const declaredSlot of room.members) {
          const declaredMember = teamNode.members.find((member) => member.id === declaredSlot);
          if (!declaredMember) {
            if (isAttachedExternalRoomMember(
              teamNode,
              network.id,
              declaredSlot
            )) {
              continue;
            }
            if (isDeclaredPairedRemoteRoomMember(network, room, declaredSlot)) {
              continue;
            }
            throw new SpawnfileError(
              "validation_error",
              `Team ${teamNode.name} Moltnet room ${room.id} references unknown member ${declaredSlot}`
            );
          }

          if (declaredMember.kind === "agent") {
            const agentNode = findAgentBySource(plan, declaredMember.nodeSource);
            const policy = findDirectRoomPolicy(
              plan,
              teamNode,
              agentNode.source,
              declaredSlot,
              network.id,
              room.id
            );
            memberships.push({
              agentName: agentNode.name,
              agentSource: agentNode.source,
              concreteMemberId: resolveConcreteMemberId(plan, agentNode.source, declaredSlot),
              declaredSlot,
              declaringTeamName: teamNode.name,
              declaringTeamSource: teamNode.source,
              directTeamName: teamNode.name,
              directTeamSource: teamNode.source,
              networkId: network.id,
              ...(policy ? { policy } : {}),
              roomId: room.id
            });
            continue;
          }

          const childTeam = findTeamBySource(plan, declaredMember.nodeSource);
          const representatives = resolveTeamRepresentatives(plan, childTeam);
          if (representatives.length === 0) {
            throw new SpawnfileError(
              "validation_error",
              `Team ${childTeam.name} has no concrete representative for Moltnet room ${room.id} on ${teamNode.name}`
            );
          }

          for (const representative of representatives) {
            const agentNode = findAgentBySource(plan, representative.agentSource);
            const policy = findDirectRoomPolicy(
              plan,
              teamNode,
              agentNode.source,
              representative.memberId,
              network.id,
              room.id
            ) ?? defaultNestedRepresentativePolicy();
            memberships.push({
              agentName: agentNode.name,
              agentSource: agentNode.source,
              concreteMemberId: resolveConcreteMemberId(
                plan,
                representative.agentSource,
                representative.memberId
              ),
              declaredSlot,
              declaringTeamName: teamNode.name,
              declaringTeamSource: teamNode.source,
              directTeamName: representative.sourceTeamName,
              directTeamSource: representative.sourceTeamSource,
              networkId: network.id,
              representedSlot: declaredSlot,
              representedTeamName: childTeam.name,
              representedTeamSource: childTeam.source,
              representativePath: [declaredSlot, ...representative.path],
              ...(policy ? { policy } : {}),
              roomId: room.id
            });
          }
        }
      }
    }
  }

  return memberships.sort(compareRoomMemberships);
};
