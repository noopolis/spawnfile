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
  const failures = new Map<string, Set<string>>();

  for (const node of plan.nodes) {
    if (node.value.kind !== "agent") continue;
    const runtimeName = node.runtimeName ?? node.value.runtime.name;
    const adapter = getRuntimeAdapter(runtimeName);
    const key = `${node.id} (${runtimeName})`;
    const report = (message: string): void => {
      failures.set(key, (failures.get(key) ?? new Set()).add(message));
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

  if (failures.size > 0) {
    const lines = [...failures].flatMap(([agent, messages]) => [...messages].map((message) => `- ${agent}: ${message}`));
    throw new SpawnfileError(
      "validation_error",
      [`Compile would refuse ${failures.size} agent(s):`, ...lines].join("\n")
    );
  }
};
