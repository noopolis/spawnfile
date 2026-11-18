import { getRuntimeOperations } from "../runtime/registry.js";
import type { RuntimeRecordingOperations } from "../runtime/operations.js";
import { SpawnfileError } from "../shared/index.js";
import type { CompilePlan, CompilePlanNode } from "./types.js";

export const recordingOperationFor = (node: CompilePlanNode): RuntimeRecordingOperations => {
  const recording = node.runtimeName === null ? undefined : getRuntimeOperations(node.runtimeName)?.recording;
  if (!recording) {
    throw new SpawnfileError("validation_error",
      `Training recording for ${node.id}: runtime ${node.runtimeName ?? "unknown"} does not support wake moments`);
  }
  return recording;
};

/** No runtime lookup or manifest I/O when recording is absent. */
export const assertRecordingCapability = async (
  plan: CompilePlan, authorityOverride?: unknown
): Promise<void> => {
  const operations = new Set(plan.nodes
    .filter((node) => node.kind === "agent" && node.value.training?.record !== undefined)
    .map(recordingOperationFor));
  for (const recording of operations) await recording.assertSupported(authorityOverride);
};
