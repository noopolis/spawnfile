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
  model_auth_methods: Record<string, ModelAuthMethod>;
  model_secrets_required: string[];
  runtime: string;
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
  model_secrets_required: string[];
  ports: number[];
  runtime_instances: ContainerRuntimeInstanceReport[];
  runtime_homes: string[];
  runtime_secrets_required: string[];
  runtimes_installed: string[];
  secrets_required: string[];
}

export interface CompileReport {
  container?: ContainerReport;
  diagnostics: DiagnosticReport[];
  nodes: NodeReport[];
  root: string;
  spawnfile_version: "0.1";
}
