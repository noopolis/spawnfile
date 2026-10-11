import type { ContainerMemoryReport, RecordingReport } from "../report/index.js";
import { maxRecordingKeepMs } from "../shared/index.js";

import type { CompilePlan } from "./types.js";

/** Project effective agent declarations and existing memory access facts only. */
export const resolveRecordingReport = (
  plan: CompilePlan,
  memories: readonly ContainerMemoryReport[]
): RecordingReport | undefined => {
  const agents = plan.nodes.filter((node) => node.kind === "agent" && node.value.training?.record !== undefined);
  const keepMs = maxRecordingKeepMs(agents.map((node) => node.value.training?.record));
  if (keepMs === undefined) return undefined;
  const agentIds = new Set(agents.map((node) => node.id));
  const memoryMountIds = memories.flatMap((memory) =>
    memory.store.persistent_mount_id !== undefined && memory.accessible_node_ids.some((id) => agentIds.has(id))
      ? [memory.store.persistent_mount_id] : []);
  return { keep_ms: keepMs, memory_mount_ids: [...new Set(memoryMountIds)].sort() };
};
