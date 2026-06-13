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
  durability: "persistent";
  id: string;
  kind: "volume";
  target: string;
}

export interface DistributionWorkspaceResource {
  id: string;
  kind: "git" | "volume";
  link_path: string;
  mode: "mutable" | "readonly";
  mount: string;
  sharing: "per_agent" | "team";
}

export interface DistributionRuntimeInstance {
  config_path: string;
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

export interface DistributionMoltnetNetwork {
  binding: "env";
  id: string;
  server_mode: "external" | "managed";
}

export interface DistributionPortMapping {
  internal_port: number;
  published_port: number;
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
}

export const DISTRIBUTION_REPORT_VERSION = "spawnfile.distribution-report.v1";
export const DISTRIBUTION_REPORT_IMAGE_PATH = "/spawnfile/spawnfile-report.json";
export const DISTRIBUTION_REPORT_OUTPUT_FILE = "distribution-report.json";
export const IMAGE_CONTRACT_VERSION = "spawnfile.image.v1";

export type DistributionImageLabels = Record<
  | "com.spawnfile.compile_fingerprint"
  | "com.spawnfile.image_contract"
  | "com.spawnfile.project"
  | "com.spawnfile.report",
  string
> &
  Record<string, string>;
