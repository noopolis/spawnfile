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
  source: string;
}

export interface CompileReport {
  diagnostics: DiagnosticReport[];
  nodes: NodeReport[];
  root: string;
  spawnfile_version: "0.1";
}
