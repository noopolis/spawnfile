import type { CapabilityReport, DiagnosticReport } from "../report/index.js";
import type { EmittedFile } from "../runtime/index.js";

import type {
  ResolvedMemberRef,
  ResolvedTeamMembershipContext,
  ResolvedTeamNode
} from "./types.js";

export interface TeamCompileSupport {
  capabilitiesByTeamSource: Map<string, CapabilityReport[]>;
  diagnosticsByTeamSource: Map<string, DiagnosticReport[]>;
  filesByAgentSource: Map<string, EmittedFile[]>;
}

export interface DirectContext {
  contextKey: string;
  kind: "direct";
  membership: ResolvedTeamMembershipContext;
  teamNode: ResolvedTeamNode;
}

export interface RepresentativeContext {
  contextKey: string;
  delegateRole: "lead" | "representative";
  kind: "representative";
  parentTeamNode: ResolvedTeamNode;
  representedMember: ResolvedMemberRef;
  representativeMemberId: string;
  representativeSource: string;
}

export type AgentContext = DirectContext | RepresentativeContext;

export interface TeamContextIndex {
  direct_memberships: Array<Record<string, unknown>>;
  representations: Array<Record<string, unknown>>;
}
