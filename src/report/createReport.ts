import { CompileReport, ContainerReport, DiagnosticReport, NodeReport } from "./types.js";

export const createCompileReport = (
  root: string,
  nodes: NodeReport[],
  diagnostics: DiagnosticReport[] = [],
  container?: ContainerReport
): CompileReport => ({
  ...(container ? { container } : {}),
  diagnostics,
  nodes,
  root,
  spawnfile_version: "0.1"
});
