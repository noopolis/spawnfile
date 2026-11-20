import { findRuntimeWiring } from "../runtime/index.js";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { shellQuote } from "./containerEntrypointShell.js";

/** Wait for the runtime's declared HTTP endpoint and fail early if its child exits. */
export const createRuntimeReadinessWait = (plan: RuntimeTargetPlan, pidVariable: string): string[] => {
  const readiness = findRuntimeWiring(plan.runtimeName)?.readiness;
  if (!plan.port || !readiness) return [];
  const exitLabel = readiness.exitLabel ?? plan.runtimeName;
  return [
    "attempts=0",
    `until curl -sf ${shellQuote(`http://127.0.0.1:${plan.port}${readiness.path}`)} >/dev/null; do`,
    `  if ! kill -0 "$${pidVariable}" 2>/dev/null; then wait "$${pidVariable}" || true; echo ${shellQuote(`${exitLabel} exited before readiness on port ${plan.port}`)} >&2; exit 1; fi`,
    "  attempts=$((attempts + 1))",
    '  if [ "$attempts" -ge 180 ]; then',
    `    echo ${shellQuote(`Timed out waiting for ${plan.runtimeName} on port ${plan.port}`)} >&2`,
    "    exit 1",
    "  fi",
    "  sleep 1",
    "done",
    ""
  ];
};
