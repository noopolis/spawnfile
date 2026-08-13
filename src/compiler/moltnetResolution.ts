import { SpawnfileError } from "../shared/index.js";

import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedMoltnetAttachment,
  ResolvedMoltnetRoomMembership,
  ResolvedTeamNode
} from "./types.js";
import { resolveMoltnetRoomMemberships } from "./moltnetRoomMemberships.js";
import {
  resolveMoltnetAttachments,
  resolveTeamRepresentatives
} from "./moltnetRepresentativeResolution.js";
import { resolveCanonicalAgentMemberId } from "./organizationIdentity.js";
export {
  resolveMoltnetAttachments,
  resolveTeamRepresentatives,
  type MoltnetTeamContext,
  type TeamRepresentativeResolution
} from "./moltnetRepresentativeResolution.js";

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

const hasMoltnetIntent = (plan: CompilePlan): boolean =>
  plan.nodes.some((node) => {
    if (node.value.kind === "team") {
      return (node.value.networks?.length ?? 0) > 0;
    }

    return (node.value.surfaces?.moltnet?.length ?? 0) > 0;
  });

const validateGlobalMemberIds = (plan: CompilePlan): void => {
  if (!hasMoltnetIntent(plan)) {
    return;
  }

  const seen = new Map<string, { agentSource: string; label: string }>();
  const uniqueContexts = new Map(
    (plan.memberships ?? []).map((context) => [
      `${context.teamSource}::${context.memberId}::${context.agentSource}`,
      context
    ])
  );

  for (const context of uniqueContexts.values()) {
    let memberId = context.memberId;
    if (plan.organizationIdentity) {
      const canonicalMemberId = resolveCanonicalAgentMemberId(plan, context.agentSource);
      const matches = plan.organizationIdentity.agentMembers.filter(
        (member) => member.memberId === canonicalMemberId
      );
      if (!canonicalMemberId || matches.length !== 1) {
        throw new SpawnfileError(
          "validation_error",
          `Unable to resolve exactly one canonical Moltnet member id for ${context.agentSource}`
        );
      }
      memberId = canonicalMemberId;
    }
    const previous = seen.get(memberId);
    const label = `${context.teamName} (${context.teamSource}) member ${context.memberId}`;
    if (
      previous &&
      previous.agentSource !== context.agentSource
    ) {
      throw new SpawnfileError(
        "validation_error",
        `Moltnet member_id ${memberId} is declared by multiple direct agent member slots: ${previous.label}; ${label}`
      );
    }

    seen.set(memberId, { agentSource: context.agentSource, label });
  }
};

const getRoomMemberships = (
  plan: CompilePlan
): ResolvedMoltnetRoomMembership[] => {
  const memberships = plan.moltnetRoomMemberships ?? resolveMoltnetRoomMemberships(plan);
  plan.moltnetRoomMemberships = memberships;

  return memberships;
};

interface SynthesizedRepresentativeAttachment {
  agentSource: string;
  attachment: ResolvedMoltnetAttachment;
  directTeamSource: string;
}

const synthesizeRepresentativeAttachments = (
  memberships: ResolvedMoltnetRoomMembership[]
): SynthesizedRepresentativeAttachment[] =>
  memberships
    .filter((membership) => membership.representedSlot !== undefined)
    .map((membership) => ({
      agentSource: membership.agentSource,
      directTeamSource: membership.directTeamSource,
      attachment: {
        contextRooms: {
          [membership.declaringTeamSource]: [membership.roomId]
        },
        memberId: membership.concreteMemberId,
        network: membership.networkId,
        rooms: {
          [membership.roomId]: membership.policy ? { ...membership.policy } : {}
        },
        teamSource: membership.declaringTeamSource
      }
    }));

const areEquivalentDmPolicy = (
  left: NonNullable<ResolvedMoltnetAttachment["dms"]>,
  right: NonNullable<ResolvedMoltnetAttachment["dms"]>
): boolean => {
  if (left.enabled !== right.enabled || left.wake !== right.wake) {
    return false;
  }

  const leftSenders = left.allowedWakeSenders;
  const rightSenders = right.allowedWakeSenders;
  if (leftSenders === undefined || rightSenders === undefined) {
    return leftSenders === rightSenders;
  }

  if (leftSenders.length !== rightSenders.length) {
    return false;
  }

  return leftSenders.every((sender, index) =>
    sender === rightSenders[index]
  );
};

const areEquivalentRoomPolicy = (
  left: NonNullable<ResolvedMoltnetAttachment["rooms"]>[string],
  right: NonNullable<ResolvedMoltnetAttachment["rooms"]>[string]
): boolean => left.wake === right.wake;

const hasRoomPolicy = (
  policy: NonNullable<ResolvedMoltnetAttachment["rooms"]>[string]
): boolean =>
  policy.wake !== undefined;

const cloneMoltnetDm = (
  dms: NonNullable<ResolvedMoltnetAttachment["dms"]>
): NonNullable<ResolvedMoltnetAttachment["dms"]> => ({
  ...dms,
  ...(dms.allowedWakeSenders !== undefined
    ? { allowedWakeSenders: [...dms.allowedWakeSenders] }
    : {})
});

const mergeAttachment = (
  target: ResolvedMoltnetAttachment,
  next: ResolvedMoltnetAttachment,
  nodeName: string
): void => {
  if (
    target.auth &&
    next.auth &&
    target.auth.tokenId !== next.auth.tokenId
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Agent ${nodeName} declares incompatible Moltnet auth for ${next.network}/${next.memberId ?? "unknown"}`
    );
  }
  if (!target.auth && next.auth) {
    target.auth = { ...next.auth };
  }

  if (
    target.dms &&
    next.dms &&
    !areEquivalentDmPolicy(target.dms, next.dms)
  ) {
    throw new SpawnfileError(
      "validation_error",
      `Agent ${nodeName} declares incompatible Moltnet dms for ${next.network}/${next.memberId ?? "unknown"}`
    );
  }

  if (!target.dms && next.dms) {
    target.dms = cloneMoltnetDm(next.dms);
  }
  target.teamSource ??= next.teamSource;
  target.rooms ??= {};

  for (const [roomId, policy] of Object.entries(next.rooms ?? {})) {
    const existingPolicy = target.rooms[roomId];
    const existingHasPolicy = existingPolicy ? hasRoomPolicy(existingPolicy) : false;
    const nextHasPolicy = hasRoomPolicy(policy);
    if (
      existingHasPolicy &&
      nextHasPolicy &&
      !areEquivalentRoomPolicy(existingPolicy, policy)
    ) {
      throw new SpawnfileError(
        "validation_error",
        `Agent ${nodeName} declares incompatible Moltnet room policy for ${next.network}/${next.memberId ?? "unknown"} room ${roomId}`
      );
    }

    target.rooms[roomId] = existingPolicy && existingHasPolicy && !nextHasPolicy
      ? { ...existingPolicy }
      : { ...policy };
  }

  if (next.contextRooms) {
    target.contextRooms ??= {};
    for (const [teamSource, roomIds] of Object.entries(next.contextRooms)) {
      target.contextRooms[teamSource] = [
        ...new Set([...(target.contextRooms[teamSource] ?? []), ...roomIds])
      ].sort();
    }
  } else if (next.teamSource) {
    target.contextRooms ??= {};
    target.contextRooms[next.teamSource] = [
      ...new Set([
        ...(target.contextRooms[next.teamSource] ?? []),
        ...Object.keys(next.rooms ?? {})
      ])
    ].sort();
  }
};

const mergeAgentAttachments = (
  agentNode: ResolvedAgentNode,
  attachments: ResolvedMoltnetAttachment[]
): ResolvedMoltnetAttachment[] => {
  const merged = new Map<string, ResolvedMoltnetAttachment>();

  for (const attachment of attachments) {
    const key = `${attachment.network}::${attachment.memberId ?? ""}`;
    const existing = merged.get(key);
    if (existing) {
      mergeAttachment(existing, attachment, agentNode.name);
      continue;
    }

    merged.set(key, {
      ...(attachment.auth ? { auth: { ...attachment.auth } } : {}),
      contextRooms: attachment.contextRooms
        ? Object.fromEntries(
            Object.entries(attachment.contextRooms).map(([teamSource, roomIds]) => [
              teamSource,
              [...roomIds].sort()
            ])
          )
        : attachment.teamSource
          ? { [attachment.teamSource]: Object.keys(attachment.rooms ?? {}).sort() }
          : undefined,
      ...(attachment.dms ? { dms: cloneMoltnetDm(attachment.dms) } : {}),
      memberId: attachment.memberId,
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
      teamSource: attachment.teamSource
    });
  }

  return [...merged.values()].sort((left, right) =>
    `${left.network}:${left.memberId ?? ""}`.localeCompare(`${right.network}:${right.memberId ?? ""}`)
  );
};

export const resolvePlanMoltnetAttachments = (plan: CompilePlan): void => {
  validateGlobalMemberIds(plan);
  const roomMemberships = getRoomMemberships(plan);
  const synthesizedAttachments = synthesizeRepresentativeAttachments(roomMemberships);
  const synthesizedByAgent = new Map<string, ResolvedMoltnetAttachment[]>();

  for (const synthesized of synthesizedAttachments) {
    const { agentSource, attachment, directTeamSource } = synthesized;
    const representativeContext = (plan.memberships ?? []).find((context) =>
      context.agentSource === agentSource &&
      (plan.organizationIdentity
        ? context.teamSource === directTeamSource
        : context.memberId === attachment.memberId)
    );
    if (!representativeContext) {
      throw new SpawnfileError(
        "validation_error",
        `Unable to find direct member context for synthesized Moltnet member ${attachment.memberId ?? "unknown"}`
      );
    }

    const group = synthesizedByAgent.get(representativeContext.agentSource) ?? [];
    group.push(attachment);
    synthesizedByAgent.set(representativeContext.agentSource, group);
  }

  for (const node of plan.nodes) {
    if (node.value.kind !== "agent") {
      continue;
    }

    const agentNode = node.value;
    const declaredAttachments = agentNode.surfaces?.moltnet;
    const directContexts = (plan.memberships ?? []).filter(
      (context) => context.agentSource === agentNode.source
    );
    const resolvedAttachments: ResolvedMoltnetAttachment[] = [];

    if (declaredAttachments && directContexts.length === 0) {
      throw new SpawnfileError(
        "validation_error",
        `Agent ${agentNode.name} declares Moltnet surfaces but is not attached to a team network`
      );
    }

    for (const context of directContexts) {
      if (!declaredAttachments) {
        continue;
      }

      const teamNode = findTeamBySource(plan, context.teamSource);
      const canonicalMemberId =
        resolveCanonicalAgentMemberId(plan, context.agentSource) ?? context.memberId;
      const resolved = resolveMoltnetAttachments(
        declaredAttachments,
        {
          memberId: context.memberId,
          networks: teamNode.networks ?? [],
          resolvedMemberId: canonicalMemberId,
          teamName: context.teamName,
          teamSource: context.teamSource
        },
        agentNode.name
      );
      resolvedAttachments.push(...(resolved ?? []));
    }

    resolvedAttachments.push(...(synthesizedByAgent.get(agentNode.source) ?? []));

    if (resolvedAttachments.length > 0) {
      agentNode.surfaces = {
        ...agentNode.surfaces,
        moltnet: mergeAgentAttachments(agentNode, resolvedAttachments)
      };
    } else if (agentNode.surfaces?.moltnet) {
      agentNode.surfaces = {
        ...agentNode.surfaces,
        moltnet: undefined
      };
    }
  }
};
