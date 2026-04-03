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

export interface ResolvedWhatsAppSurface {
  access?: {
    groups: string[];
    mode: "allowlist" | "open" | "pairing";
    users: string[];
  };
}

export interface ResolvedSlackSurface {
  access?: {
    channels: string[];
    mode: "allowlist" | "open" | "pairing";
    users: string[];
  };
  appTokenSecret: string;
  botTokenSecret: string;
}

export interface ResolvedHttpSurface {
  access?: {
    mode: "open";
  };
  auth?: {
    mode: "bearer";
    tokenSecret?: string;
  };
  pathPrefix: string;
  port?: number;
}

export interface ResolvedMoltnetRoomPolicy {
  read?: "all" | "mentions" | "thread_only";
  reply?: "auto" | "manual" | "never";
}

export interface ResolvedMoltnetDMConfig extends ResolvedMoltnetRoomPolicy {
  enabled: boolean;
}

export interface ResolvedMoltnetAttachment {
  dms?: ResolvedMoltnetDMConfig;
  memberId: string | null;
  network: string;
  rooms?: Record<string, ResolvedMoltnetRoomPolicy>;
  teamSource: string | null;
}

export interface ResolvedWebhookSurface {
  signingSecret?: string;
  url: string;
}

export interface ResolvedAgentSurfaces {
  discord?: ResolvedDiscordSurface;
  http?: ResolvedHttpSurface;
  moltnet?: ResolvedMoltnetAttachment[];
  slack?: ResolvedSlackSurface;
  telegram?: ResolvedTelegramSurface;
  webhook?: ResolvedWebhookSurface;
  whatsapp?: ResolvedWhatsAppSurface;
}

export interface ResolvedTeamNetworkRoom {
  id: string;
  members: string[];
}

export interface ResolvedTeamNetwork {
  expose?: boolean;
  id: string;
  name: string;
  provider: "moltnet";
  rooms: ResolvedTeamNetworkRoom[];
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
  description: string;
  docs: ResolvedDocument[];
  env: StringMap;
  execution: ExecutionBlock | undefined;
  expose?: boolean;
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

export interface ResolvedTeamNode {
  auth: { mode: "shared_secret"; secret: string } | null;
  description: string;
  docs: ResolvedDocument[];
  external: string[];
  kind: "team";
  lead: string | null;
  members: ResolvedMemberRef[];
  mode: "hierarchical" | "swarm";
  name: string;
  networks?: ResolvedTeamNetwork[];
  policyMode: string | null;
  policyOnDegrade: string | null;
  shared: {
    env: StringMap;
    mcpServers: McpServer[];
    secrets: Secret[];
    skills: ResolvedSkill[];
  };
  source: string;
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
