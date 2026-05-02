import type { DiagnosticReport } from "../report/index.js";

import type { ResolvedMemberRef } from "./types.js";

export interface RosterRepresentativeEntry {
  addresses: Record<string, unknown>;
  delegate_role?: "lead" | "representative";
  description: string;
  surfaces: string[];
}

export interface RosterEntry {
  addresses: Record<string, unknown>;
  card?: {
    path: string;
    summary: string;
  };
  description: string;
  is_lead?: boolean;
  representatives?: Record<string, RosterRepresentativeEntry>;
  role: "lead" | "member" | "team";
  surfaces: string[];
}

export interface Roster {
  context_kind?: "direct" | "representative";
  lead: string | null;
  members: Record<string, RosterEntry>;
  mode: "hierarchical" | "swarm";
  represents?: {
    delegate_role: "lead" | "representative";
    representative: string;
    slot: string;
  };
  self: string;
  team: string;
}

export interface GenerateTeamRosterOptions {
  contextKey: string;
  delegateRole?: "lead" | "representative";
  representedSlotId?: string;
  selfMemberId: string;
  teamSource: string;
}

export interface GeneratedTeamRoster {
  diagnostics: DiagnosticReport[];
  roster: string;
  visibleMembers: ResolvedMemberRef[];
}
