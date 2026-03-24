import type {
  EffectiveModelTarget,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "../compiler/types.js";
import type { ResolvedAuthProfile } from "../auth/index.js";
import type { AgentManifest } from "../manifest/index.js";
import type { CapabilityReport, DiagnosticReport } from "../report/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";

export interface EmittedFile {
  content: string;
  path: string;
}

export interface RuntimeAgentScaffold {
  files: EmittedFile[];
  manifest: AgentManifest;
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
  configEnvBindings?: RuntimeContainerConfigEnvBinding[];
  envFiles?: ContainerTargetEnvFile[];
  files: EmittedFile[];
  id: string;
  sourceIds?: string[];
}

export interface RuntimeContainerInstancePaths {
  configPathTemplate: string;
  homePathTemplate?: string;
  workspacePathTemplate: string;
}

export interface RuntimeContainerConfigEnvBinding {
  envName: string;
  jsonPath: string;
}

export interface RuntimeContainerMeta {
  configFileName: string;
  configEnvBindings?: RuntimeContainerConfigEnvBinding[];
  configPathEnv?: string;
  env?: Array<{
    description: string;
    name: string;
    required: boolean;
  }>;
  homeEnv?: string;
  instancePaths: RuntimeContainerInstancePaths;
  globalNpmPackages?: string[];
  port?: number;
  portEnv?: string;
  standaloneBaseImage: string;
  startCommand: string[];
  staticEnv?: Record<string, string>;
  systemDeps: string[];
}

export interface RuntimeAuthPreparationInput {
  authProfile: ResolvedAuthProfile;
  env: Record<string, string>;
  instance: ContainerRuntimeInstanceReport;
  outputDirectory: string;
  tempRoot: string;
}

export interface RuntimeAuthPreparationResult {
  coveredModelSecrets: string[];
  mountArgs: string[];
}

export interface AdapterCompileResult {
  capabilities: CapabilityReport[];
  diagnostics: DiagnosticReport[];
  files: EmittedFile[];
}

export interface RuntimeAdapter {
  assertSupportedModelTarget(target: EffectiveModelTarget): void;
  container: RuntimeContainerMeta;
  compileAgent(node: ResolvedAgentNode): Promise<AdapterCompileResult>;
  compileTeam?(node: ResolvedTeamNode): Promise<AdapterCompileResult>;
  createContainerTargets?(inputs: ContainerTargetInput[]): Promise<ContainerTarget[]>;
  name: string;
  prepareRuntimeAuth?(
    input: RuntimeAuthPreparationInput
  ): Promise<RuntimeAuthPreparationResult>;
  scaffoldAgentProject?(): RuntimeAgentScaffold;
  validateRuntimeOptions?(options: Record<string, unknown>): DiagnosticReport[];
}
