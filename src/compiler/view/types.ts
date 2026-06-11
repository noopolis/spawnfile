import type { ResolvedMoltnetRoomPolicy } from "../types.js";

export interface OrganizationViewDocSummary {
  role: string;
  source: string;
}

export interface OrganizationViewSkillSummary {
  name: string;
  ref: string;
  requiresMcp: string[];
}

export interface OrganizationViewResourceSummary {
  id: string;
  kind: "git" | "volume";
  mode: "mutable" | "readonly";
  mount: string;
  sharing: "per_agent" | "team";
}

export interface OrganizationViewPackageSummary {
  id: string;
  manager: string;
  name: string;
  scope?: string;
  version?: string;
}

export interface OrganizationViewMcpSummary {
  name: string;
  transport: "sse" | "stdio" | "streamable_http";
}

export interface OrganizationViewModelSummary {
  authMethod: string;
  name: string;
  provider: string;
}

export interface OrganizationViewScheduleSummary {
  expression?: string;
  kind: "cron" | "disabled" | "every";
  timezone?: string;
}

export interface OrganizationViewSurfaceSummary {
  name: string;
  scopes: string[];
}

export interface OrganizationViewPolicySummary {
  mode: string | null;
  onDegrade: string | null;
}

export interface OrganizationViewDeclaredSummary {
  docs: OrganizationViewDocSummary[];
  mcpServers: OrganizationViewMcpSummary[];
  model: OrganizationViewModelSummary | null;
  packages: OrganizationViewPackageSummary[];
  policy: OrganizationViewPolicySummary;
  resources: OrganizationViewResourceSummary[];
  schedule: OrganizationViewScheduleSummary | null;
  skills: OrganizationViewSkillSummary[];
  surfaces: OrganizationViewSurfaceSummary[];
}

export interface OrganizationViewTreeNode {
  children: OrganizationViewTreeEdge[];
  declared?: OrganizationViewDeclaredSummary;
  displayName: string;
  external?: string[];
  id: string;
  kind: "agent" | "team";
  lead?: string | null;
  mode?: "hierarchical" | "swarm";
  name: string;
  networks?: OrganizationTreeNetworkSummary[];
  runtimeName: string | null;
  slug?: string;
  source: string;
}

export interface OrganizationTreeNetworkRoomSummary {
  declaredMembers: string[];
  id: string;
  visibility?: "public" | "private";
  writePolicy?: "members" | "operators" | "registered_agents";
}

export interface OrganizationTreeNetworkSummary {
  agentRegistration?: "disabled" | "open" | "token";
  authMode?: "bearer" | "none" | "open";
  consoleAnalytics?: string;
  debugEvents?: boolean;
  directMessages?: boolean;
  expose?: boolean;
  httpEnabled?: boolean;
  id: string;
  name: string;
  provider: "moltnet";
  publicRead?: boolean;
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
  agentRegistration?: "disabled" | "open" | "token";
  authMode?: "bearer" | "none" | "open";
  consoleAnalytics?: string;
  debugEvents?: boolean;
  declaringTeamName: string;
  declaringTeamSource: string;
  directMessages?: boolean;
  expose?: boolean;
  httpEnabled?: boolean;
  name: string;
  publicRead?: boolean;
  rooms: OrganizationNetworkRoomView[];
  serverMode?: "external" | "managed";
  url?: string;
}

export interface OrganizationNetworkRoomView {
  declaredMembers: string[];
  id: string;
  members: OrganizationNetworkMemberView[];
  visibility?: "public" | "private";
  writePolicy?: "members" | "operators" | "registered_agents";
}

export interface OrganizationNetworkView {
  agentRegistration?: "disabled" | "open" | "token";
  authMode?: "bearer" | "none" | "open";
  consoleAnalytics?: string;
  debugEvents?: boolean;
  declaringTeamName: string;
  declaringTeamSource: string;
  directMessages?: boolean;
  expose?: boolean;
  httpEnabled?: boolean;
  id: string;
  name: string;
  provider: "moltnet";
  publicRead?: boolean;
  rooms: OrganizationNetworkRoomView[];
  serverMode?: "external" | "managed";
  url?: string;
  declarations?: OrganizationNetworkDeclarationView[];
}

export interface OrganizationRuntimeView {
  name: string;
  nodeIds: string[];
}

export interface OrganizationView {
  contexts: [];
  diagnostics: [];
  inputPath: string;
  networks: OrganizationNetworkView[];
  projectRoot?: string;
  root: OrganizationViewTreeNode;
  runtimes: OrganizationRuntimeView[];
}

export interface RenderOrganizationViewOptions {
  annotationFor?: (subjectKey: string) => string[];
  ascii?: boolean;
  color?: boolean;
  declared?: boolean;
  paths?: boolean;
}
