import type { ResolvedAgentNode } from "../../compiler/types.js";

export function hermesSubagentDiagnostic(parent: ResolvedAgentNode): string | undefined {
  if (!parent.subagents.length) return undefined;
  return "Hermes named-profile delegation inherits the parent's tools and cannot enforce helper-specific permissions";
}
