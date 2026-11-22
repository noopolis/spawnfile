import type { RuntimeDrainTarget } from "../runtime/operations.js";
import { getRuntimeOperations, requireRuntimeAdapters } from "../runtime/registry.js";

import { createRuntimeDrainTarget } from "./drainSupport.js";
import type { RunningUnit } from "./releaseDocker.js";
import type { ReleaseDependencies, ReleaseRequest } from "./releaseTypes.js";
import { ReleaseError } from "./types.js";

export const drainTargetsFor = async (
  request: ReleaseRequest,
  deps: ReleaseDependencies,
  unit: RunningUnit,
  { requireAll = true, runtimes }: { requireAll?: boolean; runtimes?: readonly string[] } = {}
): Promise<RuntimeDrainTarget[]> => {
  const selected = runtimes ?? await deps.runtimesOf(request, unit.imageId).catch((error: unknown) => {
    throw new ReleaseError("blocked", `cannot read which runtimes the running image holds, so it cannot be shown drainable: ${(error as Error).message}`);
  });
  // An absent adapter is not "no drain contract": skipping it would leave its turns
  // running, or report a resume that never happened and clear the drain marker.
  try {
    requireRuntimeAdapters(selected, "drain or resume the running deployment");
  } catch (error) {
    throw new ReleaseError("blocked", (error as Error).message);
  }
  const operations = [...new Set(selected)].map((runtime) => ({ runtime, drain: getRuntimeOperations(runtime)?.drain }));
  const undrainable = operations.flatMap(({ runtime, drain }) => drain ? [] : [runtime]);
  if (requireAll && (selected.length === 0 || undrainable.length > 0)) {
    throw new ReleaseError("blocked", `the running container holds runtimes without a drain contract (${undrainable.join(", ") || "none listed"}); draining it could not stop their turns. Use --no-drain to deploy over them deliberately`);
  }
  return operations.flatMap(({ runtime, drain }) => drain
    ? [createRuntimeDrainTarget(request, unit.id, unit.imageId, drain.controlTokenEnv, runtime)] : []);
};
