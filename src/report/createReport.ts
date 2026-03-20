import { CompileReport, DiagnosticReport, NodeReport } from "./types.js";

export const createCompileReport = (
  root: string,
  nodes: NodeReport[],
  diagnostics: DiagnosticReport[] = []
): CompileReport => ({
  diagnostics,
  nodes,
  root,
  spawnfile_version: "0.1"
});
