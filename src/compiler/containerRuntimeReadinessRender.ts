import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { shellQuote } from "./containerEntrypointShell.js";

/**
 * Blocks until a runtime with an HTTP port answers /healthz, failing fast if
 * the child dies first. Split out of containerEntrypointRender.ts to keep that
 * module under the repository's 400-line ceiling.
 */
export const createRuntimeReadinessWait = (plan: RuntimeTargetPlan, pidVariable: string): string[] => {
  if (!plan.port) return [];

  if (plan.runtimeName === "daimon") {
    return [
      "attempts=0",
      `until curl -sf ${shellQuote(`http://127.0.0.1:${plan.port}/healthz`)} >/dev/null; do`,
      `  if ! kill -0 "$${pidVariable}" 2>/dev/null; then wait "$${pidVariable}" || true; echo ${shellQuote(`Daimon exited before readiness on port ${plan.port}`)} >&2; exit 1; fi`,
      "  attempts=$((attempts + 1))",
      '  if [ "$attempts" -ge 180 ]; then',
      `    echo ${shellQuote(`Timed out waiting for daimon on port ${plan.port}`)} >&2`,
      "    exit 1",
      "  fi",
      "  sleep 1",
      "done",
      ""
    ];
  }

  if (!["openclaw", "pi"].includes(plan.runtimeName)) return [];

  return [
    "attempts=0",
    `until curl -sf ${shellQuote(`http://127.0.0.1:${plan.port}/healthz`)} >/dev/null; do`,
    `  if ! kill -0 "$${pidVariable}" 2>/dev/null; then wait "$${pidVariable}" || true; echo ${shellQuote(`${plan.runtimeName} exited before readiness on port ${plan.port}`)} >&2; exit 1; fi`,
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
