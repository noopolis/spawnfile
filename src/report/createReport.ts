import { createHash } from "node:crypto";

import { CompileReport, ContainerReport, DiagnosticReport, NodeReport } from "./types.js";

export interface CreateCompileReportOptions {
  compileFingerprint?: string;
  generatedAt?: string;
  outputDirectory?: string;
  projectName?: string;
}

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const createCompileFingerprint = (
  root: string,
  nodes: NodeReport[],
  diagnostics: DiagnosticReport[],
  container: ContainerReport | undefined
): string => {
  const payload = stableStringify({
    container,
    diagnostics,
    nodes,
    root,
    spawnfile_version: "0.1"
  });
  return `sf1:${createHash("sha1").update(payload).digest("hex").slice(0, 12)}`;
};

export const createCompileReport = (
  root: string,
  nodes: NodeReport[],
  diagnostics: DiagnosticReport[] = [],
  container?: ContainerReport,
  options: CreateCompileReportOptions = {}
): CompileReport => ({
  compile_fingerprint:
    options.compileFingerprint ?? createCompileFingerprint(root, nodes, diagnostics, container),
  ...(container ? { container } : {}),
  diagnostics,
  generated_at: options.generatedAt ?? new Date().toISOString(),
  nodes,
  ...(options.outputDirectory ? { output_directory: options.outputDirectory } : {}),
  ...(options.projectName ? { project_name: options.projectName } : {}),
  root,
  spawnfile_version: "0.1"
});
