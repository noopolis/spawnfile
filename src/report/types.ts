import type { RuntimeLifecycleStatus } from "../shared/index.js";
import type { ModelAuthMethod } from "../shared/index.js";

export type CapabilityOutcome = "degraded" | "supported" | "unsupported";

export interface CapabilityReport {
  key: string;
  message: string;
  outcome: CapabilityOutcome;
}

export interface DiagnosticReport {
  level: "error" | "info" | "warn";
  message: string;
}

export interface ContainerRuntimeInstanceReport {
  config_path: string;
  /** Per pi/daimon agent (keyed by node id, e.g. "agent:eleanor"): the resolved pi
   * engine kind (see `PI_ENGINE_KINDS` in `src/runtime/pi/appTemplate.ts`, e.g.
   * "scripted"), so a scripted-engine run is disclosable on the compile report rather
   * than an invisible test-only branch. Only pi/daimon runtime instances populate this. */
  engine_by_node_id?: Record<string, string>;
  home_path: string | null;
  id: string;
  internal_port?: number | null;
  model_auth_methods: Record<string, ModelAuthMethod>;
  model_secrets_required: string[];
  node_ids?: string[];
  published_port?: number | null;
  runtime: string;
  /** Per pi/daimon agent (keyed by node id, e.g. "agent:eleanor"): the id of its daimon
   * telemetry persistent mount (see `daimonTelemetryArtifacts.ts`), so
   * `artifactsExportPlan.ts` can egress `causal.jsonl` from that agent's durable volume
   * instead of `docker cp`ing it out of the (possibly already-gone) live container. */
  telemetry_mount_ids?: Record<string, string>;
  workspace_path?: string;
}

export interface ContainerWorkspaceResourceReport {
  backing_path: string;
  id: string;
  kind: "bundle" | "git" | "volume";
  link_path: string;
  mode: "mutable" | "readonly";
  mount: string;
  mount_path: string;
  replacement_sentinel?: {
    path: string;
    result: "verified_on_startup";
  };
  resolved_identity: string;
  sharing: "per_agent" | "team";
  volume_name: string | null;
}

export interface ContainerPersistentMountReport {
  id: string;
  lifecycle?: "exclusive-reattach";
  mount_path: string;
  reason: string;
  volume_name: string;
}

export interface ContainerMemoryStoreReport {
  kind: "json" | "memory" | "postgres" | "sqlite";
  dsn_secret?: string;
  path?: string;
  persistence?: "durable" | "ephemeral";
  persistent_mount_id?: string;
}

export interface ContainerMemoryIndexReport {
  graph: {
    enabled: boolean;
    kind?: "entity_graph" | "temporal_kg";
  };
  lexical: {
    enabled: boolean;
    engine?: "bm25" | "sqlite_fts";
  };
  rerank: {
    enabled: boolean;
  };
  vector: {
    enabled: boolean;
    base_url?: string;
    dimensions?: number;
    model?: string;
    provider?: "ollama";
    timeout_ms?: number;
  };
}

export interface ContainerMemoryConsolidationReport {
  mode: "disabled" | "on_threshold" | "scheduled";
  schedule?: string;
  summarize_after_events?: number;
}

export interface ContainerMemoryRetentionReport {
  forgetting: "decay" | "manual" | "ttl";
  ttl?: string;
}

export type ContainerMemoryTransport =
  | "degraded_mcp"
  | "degraded"
  | "direct"
  | "mcp"
  | "unsupported";

export interface ContainerMemoryReport {
  id: string;
  declaring_node_id: string;
  accessible_node_ids: string[];
  store: ContainerMemoryStoreReport;
  index: ContainerMemoryIndexReport;
  consolidation: ContainerMemoryConsolidationReport;
  retention: ContainerMemoryRetentionReport;
  transport_by_node_id: Record<string, ContainerMemoryTransport>;
}

interface ContainerMemoryScope {
  qualifier: string;
  scope: "global" | "team" | "room";
}

interface CompileReportMoltnetRoomBinding {
  context_key: string;
  derivation: {
    member_position: number;
    rule: string;
  };
  member_slot: string;
  roster: string;
  team_id: string;
  team_doc: string;
  session_key: string;
  memory: {
    durable_scope: {
      qualifier: string;
      scope: "team";
    };
    ephemeral_scope: {
      qualifier: string;
      scope: "room";
    };
  };
}

interface CompileReportActiveSchedule {
  context_key: string;
  derivation: { rule: string };
  environment_key: string;
  memory: {
    durable_scope: ContainerMemoryScope;
  };
  session_key: string;
}

interface CompileReportActiveDream {
  context_key: string;
  environment_key: string;
  memory: {
    durable_scope: {
      qualifier: string;
      scope: "global" | "team";
    };
  };
  session_key_template: string;
}

export interface CompileReportActiveEnvironments {
  moltnet?: Record<string, { rooms: Record<string, CompileReportMoltnetRoomBinding> }>;
  schedules?: Record<string, CompileReportActiveSchedule>;
  dreams?: Record<string, CompileReportActiveDream>;
}

export interface ContainerPortMappingReport {
  internal_port: number;
  published_port: number;
}

export interface ContainerMoltnetNodePlanSummary {
  config_path: string;
  credential_agent_id?: string;
  credential_id?: string;
  credential_secret?: string;
  member_id?: string;
  network_id: string;
}

export interface ContainerMoltnetServerPlanSummary {
  agent_registration?: "disabled" | "open" | "token";
  auth_mode?: "bearer" | "none" | "open";
  auth_tokens?: Array<{
    agents: string[];
    id: string;
    scopes: Array<"admin" | "attach" | "observe" | "pair" | "write">;
    secret: string;
  }>;
  base_url: string;
  config_path?: string;
  debug_events?: boolean;
  direct_messages?: boolean;
  human_ingress?: boolean;
  id: string;
  mode: "external" | "managed";
  network_id: string;
  network_name?: string;
  operator_agent_id?: string;
  operator_token_id?: string;
  operator_token_secret?: string;
  port?: number;
  public_read?: boolean;
  rooms: Array<{
    id: string;
    members: string[];
    visibility?: "public" | "private";
    write_policy?: "members" | "operators" | "registered_agents";
  }>;
  store_kind?: "json" | "memory" | "postgres" | "sqlite";
  trust_forwarded_proto?: boolean;
}

export interface ContainerMoltnetPlanSummary {
  node_plans: ContainerMoltnetNodePlanSummary[];
  release?: {
    architecture: "amd64" | "arm64";
    asset: string;
    asset_sha256: `sha256:${string}`;
    capabilities: readonly ["pi-bridge"] | readonly ["daimon-bridge", "pi-bridge"];
    development?: {
      mode: "local-development";
      non_production: true;
      unsigned: true;
      unpublished: true;
    };
    release_version?: string;
    source_revision?: string;
    source_sha256?: `sha256:${string}`;
    version: "spawnfile.moltnet-release-identity.v1";
  };
  server_plans: ContainerMoltnetServerPlanSummary[];
}

export interface NodeReport {
  capabilities: CapabilityReport[];
  diagnostics: DiagnosticReport[];
  active_environments?: CompileReportActiveEnvironments;
  id: string;
  kind: "agent" | "team";
  output_dir: string | null;
  runtime: string | null;
  runtime_ref: string | null;
  runtime_status: RuntimeLifecycleStatus | null;
  source: string;
}

export interface ContainerReport {
  dockerfile: string;
  entrypoint: string;
  env_example: string;
  internal_ports?: number[];
  local_daimon_runtime?: {
    capability_receipt_sha256: string;
    image_reference: string;
    registry_authority: string;
  };
  model_secrets_required: string[];
  moltnet?: ContainerMoltnetPlanSummary;
  memory?: ContainerMemoryReport[];
  port_mappings?: ContainerPortMappingReport[];
  ports: number[];
  published_ports?: number[];
  runtime_instances: ContainerRuntimeInstanceReport[];
  runtime_homes: string[];
  runtime_secrets_required: string[];
  runtimes_installed: string[];
  secrets_required: string[];
  persistent_mounts?: ContainerPersistentMountReport[];
  workspace_resources?: ContainerWorkspaceResourceReport[];
}

export interface CompileReport {
  compile_fingerprint?: string;
  container?: ContainerReport;
  diagnostics: DiagnosticReport[];
  generated_at?: string;
  nodes: NodeReport[];
  output_directory?: string;
  project_name?: string;
  root: string;
  spawnfile_version: "0.1";
}
