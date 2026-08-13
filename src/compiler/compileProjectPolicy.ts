import type { Manifest } from "../manifest/index.js";
import { createDiagnostic, type NodeReport } from "../report/index.js";

export type PolicyMode = NonNullable<Manifest["policy"]>["mode"];
export type OnDegrade = NonNullable<Manifest["policy"]>["on_degrade"];

export const enforcePolicy = (
  nodeReport: NodeReport,
  policyMode: PolicyMode | null,
  onDegrade: OnDegrade | null
): void => {
  for (const capability of nodeReport.capabilities) {
    if (capability.outcome === "unsupported") {
      if (policyMode === "strict") {
        throw new Error(
          `Policy violation: ${capability.key} is unsupported for ${nodeReport.id} (strict mode)${capability.message ? `: ${capability.message}` : ""}`
        );
      }
      if (policyMode === "warn") {
        nodeReport.diagnostics.push(
          createDiagnostic(
            "warn",
            `Policy warning: ${capability.key} is unsupported for ${nodeReport.id}${capability.message ? `: ${capability.message}` : ""}`
          )
        );
      }
    }
    if (capability.outcome === "degraded") {
      if (onDegrade === "error") {
        throw new Error(
          `Policy violation: ${capability.key} is degraded for ${nodeReport.id} (on_degrade: error)${capability.message ? `: ${capability.message}` : ""}`
        );
      }
      if (onDegrade === "warn") {
        nodeReport.diagnostics.push(
          createDiagnostic(
            "warn",
            `Policy warning: ${capability.key} is degraded for ${nodeReport.id}${capability.message ? `: ${capability.message}` : ""}`
          )
        );
      }
    }
  }
};
