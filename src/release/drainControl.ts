import type {
  RuntimeAvailability, RuntimeDrainOperations, RuntimeDrainTarget
} from "../runtime/operations.js";
import { getRuntimeOperations } from "../runtime/registry.js";
import { ReleaseError } from "./types.js";

export * from "../runtime/legacyDrainControl.generated.js";
export { waitForRuntimeDrain } from "./drainSupport.js";
export type { DrainWait, WaitForDrainedOptions } from "./drainSupport.js";

export type RuntimeControlTarget = RuntimeDrainTarget;
export type Availability = RuntimeAvailability;
export type DrainState = Availability["drain"];

export const requireDrainOperations = (target: RuntimeControlTarget): RuntimeDrainOperations => {
  const operations = target.runtime === undefined ? undefined : getRuntimeOperations(target.runtime)?.drain;
  if (!operations) throw new ReleaseError("drain-failed", "the running runtime has no registered drain contract");
  return operations;
};
