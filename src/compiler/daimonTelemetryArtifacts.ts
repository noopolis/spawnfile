import path from "node:path/posix";

import { resolveNoopolisRunId } from "../runtime/index.js";
import type { ContainerPersistentMountReport } from "../report/index.js";

import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";
import type { CompiledNodeArtifact, RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { CompilePlan } from "./types.js";

/** Only the legacy generated Pi application writes this telemetry layout. */
const PI_TELEMETRY_RUNTIME_NAMES = new Set(["pi"]);

export interface DaimonTelemetryArtifactBundle {
  /** One durable volume per legacy Pi agent, mounted onto its telemetry directory. */
  mounts: ContainerPersistentMountReport[];
  /** Runtime target plan id (e.g. "pi-app") -> { node id -> telemetry persistent mount id
   * }, so `containerArtifacts.ts` can stamp `runtime_instances[].telemetry_mount_ids` and
   * `artifactsExportPlan.ts`'s `planDaimonFiles` can resolve each agent's telemetry volume
   * without re-deriving container paths of its own. */
  telemetryMountIdsByInstance: Map<string, Record<string, string>>;
}

const createTelemetryMountId = (agentSlug: string): string =>
  `agent-${agentSlug}-daimon-telemetry`;

/**
 * Registers one run-scoped durable volume per legacy Pi agent for its daimon turn/wake
 * causal telemetry directory (`<instanceRoot>/runtime/agents/<slug>/telemetry` — the parent
 * of `causal.jsonl`, see `appCoreSource.ts`'s `runtimeHomePath`/`instanceRoot`), mirroring
 * exactly how `moltnetArtifacts.ts` mounts the Moltnet causal directory (Piece 4b,
 * Decision 21: daimon inner-truth telemetry was container-local — `docker cp` only — until
 * now). Daimon's own write path is untouched: this only makes the HOST side of that same
 * directory a named volume, so `docker rm` no longer discards it.
 */
export const createDaimonTelemetryArtifacts = (
  plan: CompilePlan,
  runtimePlans: RuntimeTargetPlan[],
  compiledNodes: CompiledNodeArtifact[]
): DaimonTelemetryArtifactBundle => {
  // Same run-scoping key as every other durable mount (see
  // moltnetArtifactPaths.ts's createPersistentVolumeName doc comment): present for
  // `spawnfile run`/`up` (which always call ensureNoopolisRunId() first), absent for a
  // bare `spawnfile compile`/`build`, keeping those byte-identical to before this module
  // existed.
  const runId = resolveNoopolisRunId(process.env);
  const agentSlugByNodeId = new Map(
    compiledNodes
      .filter((node): node is CompiledNodeArtifact & { id: string } => node.kind === "agent" && Boolean(node.id))
      .map((node) => [node.id, node.slug] as const)
  );

  const mounts: ContainerPersistentMountReport[] = [];
  const telemetryMountIdsByInstance = new Map<string, Record<string, string>>();

  for (const runtimePlan of runtimePlans) {
    if (!PI_TELEMETRY_RUNTIME_NAMES.has(runtimePlan.runtimeName) || !runtimePlan.instancePaths.homePath) {
      continue;
    }

    const instanceRoot =
      runtimePlan.instancePaths.instanceRoot ?? path.dirname(runtimePlan.instancePaths.homePath);
    const mountIdsByNodeId: Record<string, string> = {};

    for (const nodeId of runtimePlan.sourceIds ?? []) {
      const agentSlug = agentSlugByNodeId.get(nodeId);
      if (!agentSlug) {
        continue;
      }

      const mountId = createTelemetryMountId(agentSlug);
      mounts.push({
        id: mountId,
        mount_path: path.join(instanceRoot, "runtime", "agents", agentSlug, "telemetry"),
        reason: `daimon turn/wake causal telemetry for ${agentSlug}`,
        volume_name: createPersistentVolumeName(plan.root, mountId, runId)
      });
      mountIdsByNodeId[nodeId] = mountId;
    }

    if (Object.keys(mountIdsByNodeId).length > 0) {
      telemetryMountIdsByInstance.set(runtimePlan.id, mountIdsByNodeId);
    }
  }

  return {
    mounts: mounts.sort((left, right) => left.id.localeCompare(right.id)),
    telemetryMountIdsByInstance
  };
};
