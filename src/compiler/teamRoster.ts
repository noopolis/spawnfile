import YAML from "yaml";

import type { DiagnosticReport } from "../report/index.js";

import {
  resolveTeamRepresentatives,
  type TeamRepresentativeResolution
} from "./moltnetResolution.js";
import {
  collectConcreteParticipants,
  createCoordinationDiagnostics,
  createRosterEntry,
  getVisibleTeamMembers
} from "./teamRosterEntries.js";
export type {
  GeneratedTeamRoster,
  GenerateTeamRosterOptions,
  Roster,
  RosterEntry,
  RosterRepresentativeEntry
} from "./teamRosterTypes.js";
import type {
  GeneratedTeamRoster,
  GenerateTeamRosterOptions,
  Roster
} from "./teamRosterTypes.js";
import type { CompilePlan, ResolvedTeamNode } from "./types.js";

export { getVisibleTeamMembers } from "./teamRosterEntries.js";

export const generateTeamRoster = (
  teamNode: ResolvedTeamNode,
  plan: CompilePlan,
  options: GenerateTeamRosterOptions
): GeneratedTeamRoster => {
  const visibleMembers = getVisibleTeamMembers(
    teamNode,
    options.selfMemberId,
    options.delegateRole,
    options.representedSlotId
  );
  const roster: Roster = {
    ...(options.representedSlotId && options.delegateRole
      ? {
          context_kind: "representative" as const,
          represents: {
            delegate_role: options.delegateRole,
            representative: options.selfMemberId,
            slot: options.representedSlotId
          }
        }
      : { context_kind: "direct" as const }),
    lead: teamNode.lead,
    members: Object.fromEntries(
      visibleMembers.map((member) => [
        member.id,
        createRosterEntry(plan, teamNode, member, options)
      ])
    ),
    mode: teamNode.mode,
    self: options.selfMemberId,
    team: teamNode.name
  };
  const participants = collectConcreteParticipants(
    plan,
    teamNode,
    options.selfMemberId,
    visibleMembers,
    options.representedSlotId
  );

  return {
    diagnostics: createCoordinationDiagnostics(plan, teamNode, participants, options.teamSource),
    roster: YAML.stringify(roster),
    visibleMembers
  };
};

export const generateTeamRosters = (
  teamNode: ResolvedTeamNode,
  plan: CompilePlan
): { diagnostics: DiagnosticReport[]; rosters: Map<string, string> } => {
  const diagnostics: DiagnosticReport[] = [];
  const rosters = new Map<string, string>();

  for (const member of teamNode.members.filter((entry) => entry.kind === "agent")) {
    const generated = generateTeamRoster(teamNode, plan, {
      contextKey: teamNode.name,
      selfMemberId: member.id,
      teamSource: teamNode.source
    });
    rosters.set(member.id, generated.roster);
    diagnostics.push(...generated.diagnostics);
  }

  return { diagnostics, rosters };
};

export const listTeamRepresentatives = (
  plan: CompilePlan,
  teamNode: ResolvedTeamNode
): TeamRepresentativeResolution[] => resolveTeamRepresentatives(plan, teamNode);
