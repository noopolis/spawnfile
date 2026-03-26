import { ExecutionBlock, McpServer, ModelEndpoint, Secret } from "../manifest/index.js";
import { ModelAuthMethod, StringMap } from "../shared/index.js";

export interface ResolvedDocument {
  content: string;
  role: string;
  sourcePath: string;
}

export interface ResolvedSkill {
  content: string;
  name: string;
  ref: string;
  requiresMcp: string[];
  sourcePath: string;
}

export interface ResolvedRuntime {
  name: string;
  options: Record<string, unknown>;
}

export interface ResolvedDiscordSurface {
  access?: {
    channels: string[];
    guilds: string[];
    mode: "allowlist" | "open" | "pairing";
    users: string[];
  };
  botTokenSecret: string;
}

export interface ResolvedTelegramSurface {
  access?: {
    chats: string[];
    mode: "allowlist" | "open" | "pairing";
    users: string[];
  };
  botTokenSecret: string;
}

export interface ResolvedAgentSurfaces {
  discord?: ResolvedDiscordSurface;
  telegram?: ResolvedTelegramSurface;
}

export interface EffectiveModelTarget {
  auth: {
    key?: string;
    method: ModelAuthMethod;
  };
  endpoint?: ModelEndpoint;
  name: string;
  provider: string;
}

export interface ResolvedSubagentRef {
  id: string;
  nodeSource: string;
}

export interface ResolvedMemberRef {
  id: string;
  kind: "agent" | "team";
  nodeSource: string;
  runtimeName: string | null;
}

export interface ResolvedAgentNode {
  docs: ResolvedDocument[];
  env: StringMap;
  execution: ExecutionBlock | undefined;
  kind: "agent";
  mcpServers: McpServer[];
  name: string;
  policyMode: string | null;
  policyOnDegrade: string | null;
  runtime: ResolvedRuntime;
  secrets: Secret[];
  skills: ResolvedSkill[];
  source: string;
  surfaces?: ResolvedAgentSurfaces;
  subagents: ResolvedSubagentRef[];
}

export interface ResolvedTeamStructure {
  external: string[];
  leader: string | null;
  mode: "hierarchical" | "swarm";
}

export interface ResolvedTeamNode {
  docs: ResolvedDocument[];
  kind: "team";
  members: ResolvedMemberRef[];
  name: string;
  policyMode: string | null;
  policyOnDegrade: string | null;
  shared: {
    env: StringMap;
    mcpServers: McpServer[];
    secrets: Secret[];
    skills: ResolvedSkill[];
  };
  source: string;
  structure: ResolvedTeamStructure;
}

export interface CompilePlanEdge {
  from: string;
  kind: "subagent" | "team_member";
  label: string;
  to: string;
}

export interface CompilePlanNode {
  id: string;
  kind: "agent" | "team";
  runtimeName: string | null;
  slug: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
}

export interface CompilePlan {
  edges: CompilePlanEdge[];
  nodes: CompilePlanNode[];
  root: string;
  runtimes: Record<string, { nodeIds: string[] }>;
}
