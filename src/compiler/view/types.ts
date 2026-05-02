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
  expose: boolean;
  id: string;
  name: string;
  provider: "moltnet";
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
  declaringTeamName: string;
  declaringTeamSource: string;
  expose: boolean;
  name: string;
  rooms: OrganizationNetworkRoomView[];
}

export interface OrganizationNetworkRoomView {
  declaredMembers: string[];
  id: string;
  members: OrganizationNetworkMemberView[];
}

export interface OrganizationNetworkView {
  declaringTeamName: string;
  declaringTeamSource: string;
  expose: boolean;
  id: string;
  name: string;
  provider: "moltnet";
  rooms: OrganizationNetworkRoomView[];
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
