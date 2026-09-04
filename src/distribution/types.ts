/* v8 ignore file -- type-only module */
import type { ModelAuthMethod } from "../shared/index.js";

export type DistributionSecretCategory = "model" | "project" | "runtime" | "surface";

export interface DistributionSecretEntry {
  generated: boolean;
  name: string;
  required: boolean;
}

export interface DistributionAgentSummary {
  id: string;
  name: string;
  runtime: string | null;
  teams: string[];
}

export interface DistributionTeamSummary {
  agents: string[];
  id: string;
  name: string;
}

export interface DistributionOrganizationSummary {
  agents: DistributionAgentSummary[];
  project: string;
  teams: DistributionTeamSummary[];
}

export interface DistributionPersistentMount {
  /**
   * The author's own volume name for this mount, when the manifest declared
   * one. The report never carries a compiler-DERIVED name — that encodes the
   * creator's plan root and deployment lineage and stays private to that host
   * — but a declared name belongs to the published declaration and a consumer
   * honours it verbatim, so an operator who pre-created that volume attaches
   * it instead of silently getting an empty one.
   */
  declared_volume_name?: string;
  durability: "persistent";
  id: string;
  kind: "volume";
  lifecycle?: "exclusive-reattach";
  target: string;
}

export interface DistributionWorkspaceResource {
  id: string;
  kind: "bundle" | "git" | "volume";
  link_path: string;
  mode: "mutable" | "readonly";
  mount: string;
  sharing: "per_agent" | "team";
}

export interface DistributionRuntimeInstance {
  config_path: string;
  engine_by_node_id?: Record<string, string>;
  home_path: string | null;
  id: string;
  internal_port: number | null;
  model_auth_methods: Record<string, ModelAuthMethod>;
  model_secrets_required: string[];
  node_ids: string[];
  published_port: number | null;
  runtime: string;
  workspace_path: string;
}

export const DISTRIBUTION_ENGINE_KINDS = [
  "agy", "claude", "codex", "grok", "pi", "scripted"
] as const;
export type DistributionEngineKind = typeof DISTRIBUTION_ENGINE_KINDS[number];

export interface DistributionMoltnetNetwork {
  binding: "env";
  id: string;
  server_mode: "external" | "managed";
}

export interface DistributionPortMapping {
  internal_port: number;
  published_port: number;
}

export interface DistributionWorldBindingsEvidence {
  artifact_path: typeof WORLD_BINDINGS_IMAGE_PATH;
  digest: string;
  schema: "simfile.world-bindings.v1";
}

export interface DistributionReport {
  compile_fingerprint: string;
  generated_at: string;
  internal_ports: number[];
  model_auth_methods: Record<string, ModelAuthMethod>;
  moltnet: {
    networks: DistributionMoltnetNetwork[];
  };
  organization: DistributionOrganizationSummary;
  persistent_mounts: DistributionPersistentMount[];
  port_mappings: DistributionPortMapping[];
  ports: number[];
  resources: DistributionWorkspaceResource[];
  runtime_instances: DistributionRuntimeInstance[];
  secrets: Record<DistributionSecretCategory, DistributionSecretEntry[]>;
  version: "spawnfile.distribution-report.v1";
  world_bindings?: DistributionWorldBindingsEvidence;
}

export const DISTRIBUTION_REPORT_VERSION = "spawnfile.distribution-report.v1";
export const DISTRIBUTION_REPORT_IMAGE_PATH = "/spawnfile/spawnfile-report.json";
export const DISTRIBUTION_REPORT_OUTPUT_FILE = "distribution-report.json";
export const IMAGE_CONTRACT_VERSION = "spawnfile.image.v1";
export const WORLD_BINDINGS_IMAGE_PATH = "/spawnfile/world-bindings.json";

export type DistributionImageLabels = Record<
  | "com.spawnfile.compile_fingerprint"
  | "com.spawnfile.image_contract"
  | "com.spawnfile.project"
  | "com.spawnfile.report",
  string
> &
  Record<string, string>;
