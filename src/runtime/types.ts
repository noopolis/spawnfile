import type { ResolvedAgentNode, ResolvedTeamNode } from "../compiler/types.js";
import type { CapabilityReport, DiagnosticReport } from "../report/index.js";

export interface EmittedFile {
  content: string;
  path: string;
}

export interface AdapterCompileResult {
  capabilities: CapabilityReport[];
  diagnostics: DiagnosticReport[];
  files: EmittedFile[];
}

export interface RuntimeAdapter {
  compileAgent(node: ResolvedAgentNode): Promise<AdapterCompileResult>;
  compileTeam?(node: ResolvedTeamNode): Promise<AdapterCompileResult>;
  name: string;
  validateRuntimeOptions?(options: Record<string, unknown>): DiagnosticReport[];
}
