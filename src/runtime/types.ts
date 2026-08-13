import type {
  EffectiveModelTarget,
  ResolvedAgentNode,
  ResolvedAgentSurfaces,
  ResolvedTeamNode
} from "../compiler/types.js";
import type { SimfileWorldBindingV1 } from "../compiler/worldBindings.js";
import type { ResolvedAuthProfile } from "../auth/index.js";
import type { AgentManifest } from "../manifest/index.js";
import type { CapabilityReport, DiagnosticReport } from "../report/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import type { DeploymentRecord, DockerUnitInspection } from "../deployment/index.js";
import type { ModelAuthMethod } from "../shared/index.js";

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
  worldBinding?: SimfileWorldBindingV1;
}

export interface ContainerTargetEnvFile {
  envName: string;
  relativePath: string;
}

export type RuntimeContainerConfigValueTransform = "bearer";

export interface ContainerTarget {
  configEnvBindings?: RuntimeContainerConfigEnvBinding[];
  /**
   * Optional node id -> resolved engine kind map (currently only populated by
   * `src/runtime/pi/adapter.ts`'s `createContainerTargets`, e.g. `{"agent:
   * eleanor": "scripted"}`). Threaded through `RuntimeTargetPlan` into
   * `ContainerRuntimeInstanceReport.engine_by_node_id` for compile-report
   * disclosure (Piece 5, Slice B) — adapters with no engine concept simply
   * omit it.
   */
  engineByNodeId?: Record<string, string>;
  envFiles?: ContainerTargetEnvFile[];
  files: EmittedFile[];
  id: string;
  sourceIds?: string[];
  /** World token env names actually lowered into this target's native config. */
  worldTokenEnvNames?: string[];
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
  /** Legacy dot paths remain supported; structured paths address arbitrary JSON keys exactly. */
  jsonPath: string | readonly string[];
  transform?: RuntimeContainerConfigValueTransform;
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
  postRootfsCommands?: string[];
  standaloneBaseImage: string;
  startCommand: string[];
  staticEnv?: Record<string, string>;
  systemDeps: string[];
}

/**
 * The minimal runtime-instance shape an auth preparer needs. Both the compile
 * report's `ContainerRuntimeInstanceReport` and the distribution report's
 * runtime instances structurally satisfy this, so sourceless image consumption
 * can reuse the same preparers without casting through compiler-only types.
 */
export interface RuntimeAuthInstance {
  config_path: string;
  home_path: string | null;
  id: string;
  model_auth_methods: Record<string, ModelAuthMethod>;
  model_secrets_required: string[];
  runtime: string;
}

export interface RuntimeAuthPreparationInput {
  /**
   * The Spawnfile-managed auth profile (`--auth-profile`), or `null` when the
   * run/up invocation did not select one. Host-credential staging that does
   * not depend on an imported auth profile (e.g. the Pi adapter's optional
   * CLI-home mounts for grok/codex/antigravity) must still run when this is
   * `null` — only the profile-derived `imports` lookups are unavailable.
   */
  authProfile: ResolvedAuthProfile | null;
  env: Record<string, string>;
  instance: RuntimeAuthInstance;
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
