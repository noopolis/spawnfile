import type { ResolvedMoltnetRoomPolicy } from "../types.js";

export interface OrganizationViewTreeNode {
  children: OrganizationViewTreeEdge[];
  displayName: string;
  external?: string[];
  id: string;
  kind: "agent" | "team";
  lead?: string | null;
  mode?: "hierarchical" | "swarm";
  name: string;
  networks?: OrganizationTreeNetworkSummary[];
  runtimeName: string | null;
  source: string;
}

export interface OrganizationTreeNetworkRoomSummary {
  declaredMembers: string[];
  id: string;
}

export interface OrganizationTreeNetworkSummary {
  authMode?: "bearer" | "none" | "open";
  debugEvents?: boolean;
  directMessages?: boolean;
  expose?: boolean;
  httpEnabled?: boolean;
  id: string;
  name: string;
  provider: "moltnet";
  serverMode?: "external" | "managed";
  url?: string;
  rooms: OrganizationTreeNetworkRoomSummary[];
}

export interface OrganizationViewTreeEdge {
  label: string;
  node: OrganizationViewTreeNode;
  relation: "subagent" | "team_member";
}

export interface OrganizationNetworkMemberView {
  agentName: string;
  agentSource: string;
  concreteMemberId: string;
  declaredSlot: string;
  directTeamName: string;
  directTeamSource: string;
  policy?: ResolvedMoltnetRoomPolicy;
  representedSlot?: string;
  representedTeamName?: string;
  representedTeamSource?: string;
  representativePath?: string[];
}

export interface OrganizationNetworkDeclarationView {
  authMode?: "bearer" | "none" | "open";
  debugEvents?: boolean;
  declaringTeamName: string;
  declaringTeamSource: string;
  directMessages?: boolean;
  expose?: boolean;
  httpEnabled?: boolean;
  name: string;
  rooms: OrganizationNetworkRoomView[];
  serverMode?: "external" | "managed";
  url?: string;
}

export interface OrganizationNetworkRoomView {
  declaredMembers: string[];
  id: string;
  members: OrganizationNetworkMemberView[];
}

export interface OrganizationNetworkView {
  authMode?: "bearer" | "none" | "open";
  debugEvents?: boolean;
  declaringTeamName: string;
  declaringTeamSource: string;
  directMessages?: boolean;
  expose?: boolean;
  httpEnabled?: boolean;
  id: string;
  name: string;
  provider: "moltnet";
  rooms: OrganizationNetworkRoomView[];
  serverMode?: "external" | "managed";
  url?: string;
  declarations?: OrganizationNetworkDeclarationView[];
}

export interface OrganizationView {
  contexts: [];
  diagnostics: [];
  inputPath: string;
  networks: OrganizationNetworkView[];
  projectRoot?: string;
  root: OrganizationViewTreeNode;
  runtimes: [];
}

export interface RenderOrganizationViewOptions {
  ascii?: boolean;
  color?: boolean;
  declared?: boolean;
  paths?: boolean;
}
