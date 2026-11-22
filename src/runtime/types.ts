import type { RuntimeHostIntegration } from "./hostTypes.js";
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
import type { RuntimeInstallCapability } from "./containerRecipe.js";
import type { RuntimeTrainingCapability } from "./trainingTypes.js";
import type { RuntimeWiring } from "./wiringTypes.js";

export type { RuntimeWiring } from "./wiringTypes.js";

import type { RuntimeOperations } from "./operations.js";

export interface EmittedFile {
  content: string;
  mode?: number;
  /** Canonical slash-separated file path relative to this output scope. */
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

export interface ContainerTargetPersistentMount {
  id: string;
  lifecycle?: "exclusive-reattach";
  mountPath: string;
  reason: string;
}

export type RuntimeContainerConfigValueTransform = "bearer";

export interface ContainerTargetAgentPaths {
  workspacePath: string;
  homePath: string | null;
  skillRoots: string[];
}

export interface ContainerTarget {
  /** Adapter-owned paths, using the same placeholders as emitted configuration. */
  agentPathsByNodeId?: Record<string, ContainerTargetAgentPaths>;
  configEnvBindings?: RuntimeContainerConfigEnvBinding[];
  /** Adapter-resolved engine kinds by node id, carried into the compile report. */
  engineByNodeId?: Record<string, string>;
  envFiles?: ContainerTargetEnvFile[];
  /** In-memory details interpreted by the adapter that produced this target. */
  hostDetails?: object;
  files: EmittedFile[];
  id: string;
  opaqueMountTargets?: string[];
  persistentMounts?: ContainerTargetPersistentMount[];
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

export type RuntimeHomeAuthMethod = "claude-code" | "codex";

export interface RuntimeContainerMeta {
  /** These model logins are prepared per instance by the adapter for project and image launches. */
  adapterManagedAuthMethods?: readonly ModelAuthMethod[];
  /** Supported profile imports mounted into a home only for an explicit matching method. */
  rawHomeAuthImports?: readonly RuntimeHomeAuthMethod[];
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
  /** Claim a rotating grant that cannot be shared by concurrent instances. */
  reserveLoginVolume?(volume: string): void;
  /**
   * The Spawnfile-managed auth profile (`--auth-profile`), or `null` when the
   * run/up invocation did not select one. Host-credential staging that does
   * not depend on an imported auth profile (e.g. the Pi adapter's optional
   * CLI-home mounts for grok/codex/antigravity) must still run when this is
   * `null` — only the profile-derived `imports` lookups are unavailable.
   */
  authProfile: ResolvedAuthProfile | null;
  /**
   * The uid the deployed container reads bind-mounted credential files as.
   * Credential mounts carry their host owner through unchanged, so an adapter
   * whose runtime validates a credential's owner in-container must refuse a
   * mismatch here rather than at readiness. Omitted means "the uid the runtime
   * is compiled to run as", which is what every real deployment uses.
   */
  containerCredentialUid?: number;
  env: Record<string, string>;
  instance: RuntimeAuthInstance;
  outputDirectory: string;
  tempRoot: string;
}

export interface RuntimeAuthPreparationResult {
  coveredModelSecrets: string[];
  launchIdentity?: {
    kind: string;
    uid: number;
  };
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

export interface RuntimeCompileContext {
  readonly subagents: readonly { id: string; slug: string; node: ResolvedAgentNode }[];
}

export interface RuntimeAdapter {
  assertSupportedModelTarget(target: EffectiveModelTarget): void;
  assertSupportedSurfaces?(surfaces: ResolvedAgentSurfaces | undefined): void;
  container: RuntimeContainerMeta;
  compileAgent(node: ResolvedAgentNode, context?: RuntimeCompileContext): Promise<AdapterCompileResult>;
  compileTeam?(node: ResolvedTeamNode): Promise<AdapterCompileResult>;
  createContainerTargets?(inputs: ContainerTargetInput[]): Promise<ContainerTarget[]>;
  name: string;
  install: RuntimeInstallCapability;
  host?: RuntimeHostIntegration;
  operations?: RuntimeOperations;
  /** Throws a SpawnfileError for what compile would refuse for this agent; run by `spawnfile validate`. */
  preflightAgent?(node: ResolvedAgentNode, nodeId: string): void;
  prepareRuntimeAuth?(
    input: RuntimeAuthPreparationInput
  ): Promise<RuntimeAuthPreparationResult>;
  scaffoldAgentProject?(): RuntimeAgentScaffold;
  statusProbes?: RuntimeStatusProbe[];
  systemInstructionSurface?: RuntimeSystemInstructionSurface;
  training?: RuntimeTrainingCapability;
  validateRuntimeOptions?(options: Record<string, unknown>): DiagnosticReport[];
  wiring?: RuntimeWiring;
}
