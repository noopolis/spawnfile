import type {
  EffectiveModelTarget,
  ResolvedAgentNode,
  ResolvedAgentSurfaces,
  ResolvedTeamNode
} from "../compiler/types.js";
import type { ResolvedAuthProfile } from "../auth/index.js";
import type { AgentManifest } from "../manifest/index.js";
import type { CapabilityReport, DiagnosticReport } from "../report/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import type { DeploymentRecord, DockerUnitInspection } from "../deployment/index.js";

export interface EmittedFile {
  content: string;
  mode?: number;
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
  sourceWorkspacePathTemplate?: string;
  workspacePathTemplate: string;
}

export interface RuntimeContainerConfigEnvBinding {
  envName: string;
  generated?: boolean;
  jsonPath: string;
}

export interface RuntimeContainerMeta {
  configFileName: string;
  configEnvBindings?: RuntimeContainerConfigEnvBinding[];
  configPathEnv?: string;
  env?: Array<{
    description: string;
    generated?: boolean;
    name: string;
    required: boolean;
  }>;
  homeEnv?: string;
  instancePaths: RuntimeContainerInstancePaths;
  globalNpmPackages?: string[];
  port?: number;
  portStride?: number;
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

export interface RuntimeProbeExecResult {
  stderr: string;
  stdout: string;
}

export interface RuntimeProbeHttpResult {
  body: string;
  error?: string;
  ok: boolean;
}

export interface RuntimeProbeGateway {
  exec(command: string[]): Promise<RuntimeProbeExecResult>;
  httpGet(
    port: number,
    requestPath: string,
    headers?: Record<string, string>
  ): Promise<RuntimeProbeHttpResult>;
  inspectUnit(): Promise<DockerUnitInspection>;
}

export interface RuntimeProbeObservation {
  details?: Record<string, unknown>;
  key: string;
  message: string;
  severity: "error" | "ok" | "unknown" | "warn";
}

export interface RuntimeStatusProbeContext {
  deployment: DeploymentRecord;
  instance: ContainerRuntimeInstanceReport;
  manager: RuntimeProbeGateway;
  timeoutMs: number;
  unit: DeploymentRecord["units"][number];
}

export interface RuntimeStatusProbe {
  id: string;
  label: string;
  run(context: RuntimeStatusProbeContext): Promise<RuntimeProbeObservation[]>;
}

export interface RuntimeSystemInstructionSurfaceInput {
  node: ResolvedAgentNode;
}

export type RuntimeSystemInstructionPlacement =
  | "append_pointer"
  | "append_inline"
  | "replace_generated_block";

export interface RuntimeSystemInstructionSurface {
  placement: RuntimeSystemInstructionPlacement;
  resolvePath(input: RuntimeSystemInstructionSurfaceInput): string;
}

export interface AdapterCompileResult {
  capabilities: CapabilityReport[];
  diagnostics: DiagnosticReport[];
  files: EmittedFile[];
}

export interface RuntimeAdapter {
  assertSupportedModelTarget(target: EffectiveModelTarget): void;
  assertSupportedSurfaces?(surfaces: ResolvedAgentSurfaces | undefined): void;
  container: RuntimeContainerMeta;
  compileAgent(node: ResolvedAgentNode): Promise<AdapterCompileResult>;
  compileTeam?(node: ResolvedTeamNode): Promise<AdapterCompileResult>;
  createContainerTargets?(inputs: ContainerTargetInput[]): Promise<ContainerTarget[]>;
  name: string;
  prepareRuntimeAuth?(
    input: RuntimeAuthPreparationInput
  ): Promise<RuntimeAuthPreparationResult>;
  scaffoldAgentProject?(): RuntimeAgentScaffold;
  statusProbes?: RuntimeStatusProbe[];
  systemInstructionSurface?: RuntimeSystemInstructionSurface;
  validateRuntimeOptions?(options: Record<string, unknown>): DiagnosticReport[];
}
