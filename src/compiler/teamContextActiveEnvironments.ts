import type { DiagnosticReport } from "../report/index.js";
import type { CompileReportActiveEnvironments } from "../report/types.js";

import { findTeamBySource, pathSafe } from "./teamContextHelpers.js";
import type { AgentContext } from "./teamContextTypes.js";
import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedMemoryAccess
} from "./types.js";

interface AgentContextProfile {
  context: AgentContext;
  contextKey: string;
  concreteMemberId: string;
  teamSource: string;
  representedSlot?: string;
}

export type ActiveEnvironmentsIndex = CompileReportActiveEnvironments;

export interface ActiveEnvironmentsResult {
  activeEnvironments?: ActiveEnvironmentsIndex;
  diagnostics: Array<{ source: string; diagnostic: DiagnosticReport }>;
}

const ROOM_DERIVATION_RULE = "first_listed_room_member_containing_agent";
const SCHEDULE_SINGLE_DIRECT_RULE = "single_direct_team_context_for_agent_schedule";
const SCHEDULE_MULTI_CONTEXT_RULE = "multi_context_agent_schedule_uses_global_self";

const agentSessionId = (agentNode: ResolvedAgentNode): string =>
  pathSafe(agentNode.name);

const getContextProfiles = (contexts: AgentContext[]): AgentContextProfile[] =>
  contexts.map((context) =>
    context.kind === "direct"
      ? {
        context,
        contextKey: context.contextKey,
        concreteMemberId: context.membership.memberId,
        teamSource: context.teamNode.source
      }
      : {
        context,
        contextKey: context.contextKey,
        concreteMemberId: context.representativeMemberId,
        representedSlot: context.representedMember.id,
        teamSource: context.parentTeamNode.source
      }
  );

const contextKeyByMatch = {
  direct: (teamSource: string, concreteMemberId: string): string =>
    `direct:${teamSource}:${concreteMemberId}`,
  representative: (teamSource: string, representedSlot: string, concreteMemberId: string): string =>
    `representative:${teamSource}:${representedSlot}:${concreteMemberId}`
};

interface MoltnetCandidate {
  profile: AgentContextProfile;
  memberPosition: number;
}

const findRoomMemberPosition = (
  plan: CompilePlan,
  teamSource: string,
  networkId: string,
  roomId: string,
  memberSlot: string
): number => {
  const teamNode = findTeamBySource(plan, teamSource);
  if (!teamNode) {
    return -1;
  }

  const network = teamNode.networks?.find((entry) => entry.id === networkId);
  if (!network) {
    return -1;
  }

  const room = network.rooms.find((entry) => entry.id === roomId);
  if (!room) {
    return -1;
  }

  return room.members.indexOf(memberSlot);
};

const deriveMoltnetEnvironments = (
  plan: CompilePlan,
  agentNode: ResolvedAgentNode,
  profiles: AgentContextProfile[]
): {
  moltnet: ActiveEnvironmentsIndex["moltnet"] | undefined;
  diagnostics: ActiveEnvironmentsResult["diagnostics"];
} => {
  const memberships = plan.moltnetRoomMemberships;
  if (!memberships || memberships.length === 0) {
    return { moltnet: undefined, diagnostics: [] };
  }

  const direct = new Map<string, AgentContextProfile[]>();
  const representative = new Map<string, AgentContextProfile[]>();
  const profileByContextKey = new Map<string, AgentContextProfile>();

  for (const profile of profiles) {
    profileByContextKey.set(profile.contextKey, profile);

    if (profile.representedSlot === undefined) {
      const key = contextKeyByMatch.direct(profile.teamSource, profile.concreteMemberId);
      direct.set(key, [...(direct.get(key) ?? []), profile]);
    } else {
      const key = contextKeyByMatch.representative(
        profile.teamSource,
        profile.representedSlot,
        profile.concreteMemberId
      );
      representative.set(key, [...(representative.get(key) ?? []), profile]);
    }
  }

  const diagnostics: ActiveEnvironmentsResult["diagnostics"] = [];
  const byRoom = new Map<string, MoltnetCandidate[]>();

  for (const membership of memberships) {
    if (membership.agentSource !== agentNode.source) {
      continue;
    }

    const directProfiles = direct.get(
      contextKeyByMatch.direct(membership.directTeamSource, membership.concreteMemberId)
    );
    const representativeProfiles = membership.representedSlot
      ? representative.get(
          contextKeyByMatch.representative(
            membership.declaringTeamSource,
            membership.representedSlot,
            membership.concreteMemberId
          )
        )
      : undefined;
    const candidateProfiles = plan.organizationIdentity
      ? profiles.filter((profile) => membership.representedSlot
        ? profile.representedSlot === membership.representedSlot &&
          profile.teamSource === membership.declaringTeamSource
        : profile.representedSlot === undefined &&
          profile.teamSource === membership.directTeamSource)
      : membership.representedSlot
        ? representativeProfiles
        : directProfiles;

    if (!candidateProfiles || candidateProfiles.length === 0) {
      diagnostics.push({
        source: membership.declaringTeamSource,
        diagnostic: {
          level: "error",
          message: `Unable to derive active moltnet context for ${agentNode.name} in ${membership.networkId}/${membership.roomId}`
        }
      });
      continue;
    }

    const memberPosition = findRoomMemberPosition(
      plan,
      membership.declaringTeamSource,
      membership.networkId,
      membership.roomId,
      membership.declaredSlot
    );

    if (memberPosition === -1) {
      diagnostics.push({
        source: membership.declaringTeamSource,
        diagnostic: {
          level: "error",
          message: `Unable to locate room member ${membership.declaredSlot} for ${membership.networkId}/${membership.roomId} in ${agentNode.name}`
        }
      });
      continue;
    }

    const roomKey = `${membership.networkId}\u0000${membership.roomId}`;
    byRoom.set(roomKey, [
      ...(byRoom.get(roomKey) ?? []),
      ...candidateProfiles.map((profile) => ({ profile, memberPosition }))
    ]);
  }

  const moltnet: ActiveEnvironmentsIndex["moltnet"] = {};

  for (const [roomBindingKey, candidates] of byRoom) {
    if (candidates.length === 0) {
      continue;
    }

    const roomKeyed = new Map<string, MoltnetCandidate>();
    for (const candidate of candidates) {
      const existing = roomKeyed.get(candidate.profile.contextKey);
      if (!existing || candidate.memberPosition < existing.memberPosition) {
        roomKeyed.set(candidate.profile.contextKey, candidate);
      }
    }

    const selected = [...roomKeyed.values()].sort((left, right) => {
      if (left.memberPosition !== right.memberPosition) {
        return left.memberPosition - right.memberPosition;
      }
      return left.profile.contextKey.localeCompare(right.profile.contextKey);
    })[0];

    if (!selected) {
      continue;
    }

    const [networkId, roomId] = roomBindingKey.split("\u0000");
    if (!networkId || !roomId) {
      continue;
    }

    const profile = profileByContextKey.get(selected.profile.contextKey);
    if (!profile) {
      continue;
    }

    moltnet[networkId] ??= { rooms: {} };
    moltnet[networkId]!.rooms[roomId] = {
      context_key: profile.contextKey,
      derivation: {
        member_position: selected.memberPosition,
        rule: ROOM_DERIVATION_RULE
      },
      member_slot: profile.representedSlot ?? profile.concreteMemberId,
      roster: `.spawnfile/rosters/${profile.contextKey}.yaml`,
      team_id: profile.contextKey,
      team_doc: `.spawnfile/team-contexts/${profile.contextKey}/TEAM.md`,
      session_key: `${agentSessionId(agentNode)}@moltnet:${networkId}:room:${roomId}`,
      memory: {
        durable_scope: {
          qualifier: profile.contextKey,
          scope: "team"
        },
        ephemeral_scope: {
          qualifier: `${networkId}:${roomId}`,
          scope: "room"
        }
      }
    };
  }

  return {
    moltnet: Object.keys(moltnet).length > 0 ? moltnet : undefined,
    diagnostics
  };
};

const deriveSchedules = (
  profiles: AgentContextProfile[],
  directContextCount: number,
  agentNode: ResolvedAgentNode
): ActiveEnvironmentsIndex["schedules"] | undefined => {
  if (!agentNode.schedule || agentNode.schedule.kind === "disabled") {
    return undefined;
  }

  const directProfile = directContextCount === 1
    ? profiles.find((profile) => profile.context.kind === "direct")
    : undefined;

  const contextKey = directProfile ? directProfile.contextKey : "self";

  return {
    default: {
      context_key: contextKey,
      derivation: {
        rule: directProfile ? SCHEDULE_SINGLE_DIRECT_RULE : SCHEDULE_MULTI_CONTEXT_RULE
      },
      environment_key: `schedule:${contextKey}`,
      memory: {
        durable_scope: {
          qualifier: directProfile ? directProfile.contextKey : agentSessionId(agentNode),
          scope: directProfile ? "team" : "global"
        }
      },
      session_key: `${agentSessionId(agentNode)}@schedule:${contextKey}`
    }
  };
};

const hasAnyMemoryAccess = (agentNode: ResolvedAgentNode): boolean =>
  (agentNode.memoryAccess?.length ?? 0) > 0 || (agentNode.memory?.length ?? 0) > 0;

const resolveTeamMemoryScopes = (
  access: ResolvedMemoryAccess
): string | null => {
  if (access.declaringKind !== "team" || !access.slotId) {
    return null;
  }

  return `${access.source}::${access.slotId}`;
};

const deriveDreams = (
  agentNode: ResolvedAgentNode,
  profiles: AgentContextProfile[]
): ActiveEnvironmentsIndex["dreams"] | undefined => {
  const dreams: ActiveEnvironmentsIndex["dreams"] = {};

  if (hasAnyMemoryAccess(agentNode)) {
    dreams.self = {
      context_key: "self",
      environment_key: "dream:self",
      memory: {
        durable_scope: {
          qualifier: agentSessionId(agentNode),
          scope: "global"
        }
      },
      session_key_template: `${agentSessionId(agentNode)}@dream:self:{run_id}`
    };
  }

  const addProfileDream = (profile: AgentContextProfile): void => {
    dreams[profile.contextKey] ??= {
      context_key: profile.contextKey,
      environment_key: `dream:${profile.contextKey}`,
      memory: {
        durable_scope: {
          qualifier: profile.contextKey,
          scope: "team"
        }
      },
      session_key_template: `${agentSessionId(agentNode)}@dream:${profile.contextKey}:{run_id}`
    };
  };

  if ((agentNode.memory?.length ?? 0) > 0) {
    profiles.forEach(addProfileDream);
  }

  const profileByTeamSlot = new Map<string, AgentContextProfile[]>();
  for (const profile of profiles) {
    const key = `${profile.teamSource}::${profile.concreteMemberId}`;
    profileByTeamSlot.set(key, [...(profileByTeamSlot.get(key) ?? []), profile]);
  }

  for (const access of agentNode.memoryAccess ?? []) {
    const scopeKey = resolveTeamMemoryScopes(access);
    if (!scopeKey) {
      continue;
    }

    for (const profile of profileByTeamSlot.get(scopeKey) ?? []) {
      addProfileDream(profile);
    }
  }

  return Object.keys(dreams).length > 0 ? dreams : undefined;
};

export const buildActiveEnvironments = (
  plan: CompilePlan,
  agentNode: ResolvedAgentNode,
  contexts: AgentContext[],
  directContextCount: number
): ActiveEnvironmentsResult => {
  const profiles = getContextProfiles(contexts);
  const moltnetResult = deriveMoltnetEnvironments(plan, agentNode, profiles);
  const schedules = deriveSchedules(profiles, directContextCount, agentNode);
  const dreams = deriveDreams(agentNode, profiles);

  const activeEnvironments: ActiveEnvironmentsIndex = {
    ...(moltnetResult.moltnet ? { moltnet: moltnetResult.moltnet } : {}),
    ...(schedules ? { schedules } : {}),
    ...(dreams ? { dreams } : {})
  };

  if (Object.keys(activeEnvironments).length === 0) {
    return { activeEnvironments: undefined, diagnostics: moltnetResult.diagnostics };
  }

  return { activeEnvironments, diagnostics: moltnetResult.diagnostics };
};
