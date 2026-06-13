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
  home_path: string | null;
  id: string;
  internal_port?: number | null;
  model_auth_methods: Record<string, ModelAuthMethod>;
  model_secrets_required: string[];
  node_ids?: string[];
  published_port?: number | null;
  runtime: string;
  workspace_path?: string;
}

export interface ContainerWorkspaceResourceReport {
  backing_path: string;
  id: string;
  kind: "git" | "volume";
  link_path: string;
  mode: "mutable" | "readonly";
  mount: string;
  sharing: "per_agent" | "team";
}

export interface ContainerPersistentMountReport {
  id: string;
  mount_path: string;
  reason: string;
  volume_name: string;
}

export interface ContainerPortMappingReport {
  internal_port: number;
  published_port: number;
}

export interface ContainerMoltnetNodePlanSummary {
  config_path: string;
  network_id: string;
}

export interface ContainerMoltnetServerPlanSummary {
  auth_mode?: "bearer" | "none" | "open";
  base_url: string;
  config_path?: string;
  direct_messages?: boolean;
  id: string;
  mode: "external" | "managed";
  network_id: string;
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
}

export interface ContainerMoltnetPlanSummary {
  node_plans: ContainerMoltnetNodePlanSummary[];
  server_plans: ContainerMoltnetServerPlanSummary[];
}

export interface NodeReport {
  capabilities: CapabilityReport[];
  diagnostics: DiagnosticReport[];
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
  model_secrets_required: string[];
  moltnet?: ContainerMoltnetPlanSummary;
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
