import { getRuntimeAdapter } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { CompilePlan } from "./types.js";

/**
 * Runs, without emitting anything, the per-agent checks compile would refuse
 * on: runtime-option errors and each adapter's `preflightAgent` (for Daimon:
 * MCP allowlists and absolute commands, engine/model pairing, and the public
 * instruction-size limit). Every failing agent is reported, each named by its
 * node id, so `spawnfile validate` can be an organization's structural check.
 */
export const preflightCompilePlan = (plan: CompilePlan): void => {
  const failures: string[] = [];

  for (const node of plan.nodes) {
    if (node.value.kind !== "agent") continue;
    const runtimeName = node.runtimeName ?? node.value.runtime.name;
    const adapter = getRuntimeAdapter(runtimeName);
    const report = (message: string): void => {
      failures.push(`${node.id} (${runtimeName}): ${message}`);
    };

    for (const diagnostic of adapter.validateRuntimeOptions?.(node.value.runtime.options) ?? []) {
      if (diagnostic.level === "error") report(diagnostic.message);
    }
    try {
      adapter.preflightAgent?.(node.value, node.id);
    } catch (error) {
      if (!(error instanceof SpawnfileError)) throw error;
      report(error.message);
    }
  }

  if (failures.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      [`Compile would refuse ${failures.length} agent declaration(s):`, ...failures.map((failure) => `- ${failure}`)].join("\n")
    );
  }
};
