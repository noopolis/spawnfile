import type { ResolvedAgentNode, ResolvedTeamNode } from "../compiler/types.js";
import type { CapabilityReport, DiagnosticReport } from "../report/index.js";

export interface EmittedFile {
  content: string;
  path: string;
}

export interface ContainerTargetInput {
  emittedFiles: EmittedFile[];
  id: string;
  kind: "agent" | "team";
  slug: string;
  value: ResolvedAgentNode | ResolvedTeamNode;
}

export interface ContainerTargetEnvFile {
  envName: string;
  relativePath: string;
}

export interface ContainerTarget {
  envFiles?: ContainerTargetEnvFile[];
  files: EmittedFile[];
  id: string;
}

export interface RuntimeContainerInstancePaths {
  configPathTemplate: string;
  homePathTemplate?: string;
  workspacePathTemplate: string;
}

export interface RuntimeContainerMeta {
  configFileName: string;
  configPathEnv?: string;
  env?: Array<{
    description: string;
    name: string;
    required: boolean;
  }>;
  homeEnv?: string;
  instancePaths: RuntimeContainerInstancePaths;
  port?: number;
  portEnv?: string;
  standaloneBaseImage: string;
  startCommand: string[];
  staticEnv?: Record<string, string>;
  systemDeps: string[];
}

export interface AdapterCompileResult {
  capabilities: CapabilityReport[];
  diagnostics: DiagnosticReport[];
  files: EmittedFile[];
}

export interface RuntimeAdapter {
  container: RuntimeContainerMeta;
  compileAgent(node: ResolvedAgentNode): Promise<AdapterCompileResult>;
  compileTeam?(node: ResolvedTeamNode): Promise<AdapterCompileResult>;
  createContainerTargets?(inputs: ContainerTargetInput[]): Promise<ContainerTarget[]>;
  name: string;
  validateRuntimeOptions?(options: Record<string, unknown>): DiagnosticReport[];
}
