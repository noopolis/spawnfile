import type { RuntimeLifecycleStatus } from "../shared/index.js";

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
  ports: number[];
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
