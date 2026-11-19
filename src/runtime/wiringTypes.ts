import type { ResolvedMemoryBank } from "../compiler/types.js";
import type { ContainerMemoryTransport } from "../report/types.js";

export interface RuntimeMoltnetWorkspace {
  clientConfigPath: string;
  cliRuntime: string;
  skillPaths: string[];
  workspaceRootPath: string;
  installSkill?: boolean;
}

/** Inputs with container paths and stable identities already resolved by Spawnfile. */
export interface RuntimeMoltnetBridgeContext {
  agentId: string;
  agentName: string;
  basePort?: number;
  configPath: string;
  homePath?: string;
  memberId: string;
  nodeSlug: string;
  networkId: string;
  networkStateDirectory: string;
  port?: number;
  workspacePath: string;
}

export interface RuntimeMoltnetBridgeConfig {
  kind: string;
  receipt_store_path?: string;
  [key: string]: string | readonly string[] | undefined;
}

export interface RuntimeMoltnetWiring {
  kind: string;
  workspace: RuntimeMoltnetWorkspace;
  bridge(context: RuntimeMoltnetBridgeContext): RuntimeMoltnetBridgeConfig;
  /** Additional capabilities must be advertised by the authenticated Moltnet release. */
  releaseCapability?: string;
  actorTokenScopes?: readonly string[];
  statusFields?: readonly string[];
}

export interface RuntimeMemoryWiring {
  transport: ContainerMemoryTransport;
  mountPath: string | null;
}

export interface RuntimeHttpReadiness {
  path: `/${string}`;
  exitLabel?: string;
}

export interface RuntimeOperatorWakeArtifact {
  /** Path relative to the adapter's runtime installation directory. */
  filePath: string;
  markers: readonly { text: string; label: string }[];
}

export interface RuntimeWiring {
  /** Skill roots relative to the workspace in reports predating agent_paths. */
  legacyAgentSkillRoots?: readonly string[];
  moltnet?: RuntimeMoltnetWiring;
  memory?(bank: ResolvedMemoryBank): RuntimeMemoryWiring;
  operatorWakeArtifact?: RuntimeOperatorWakeArtifact;
  readiness?: RuntimeHttpReadiness;
}
