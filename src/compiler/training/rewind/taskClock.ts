import { normalizeInstant } from "./instant.js";
import { taskClockSchema } from "./contract.js";

export const createTaskClock = (origin: string) => taskClockSchema.parse({
  version: "spawnfile.task-clock.v1", origin: normalizeInstant(origin)
});
/** Offsets reported wall time only. Callers supply the real anchor at trial launch. */
export const taskClockEnvironment = (origin: string, anchorEpochMs: number): Record<string, string> => {
  if (!Number.isSafeInteger(anchorEpochMs)) throw new Error("Task clock anchorEpochMs must be a safe integer");
  const normalized = normalizeInstant(origin);
  return {
    NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: normalized, anchorEpochMs }),
    MNEME_CLOCK_ORIGIN: normalized, MNEME_CLOCK_ANCHOR_MS: String(anchorEpochMs),
    FAKETIME: `@${new Date(normalized).toISOString().slice(0, 19).replace("T", " ")}`,
    FAKETIME_DONT_FAKE_MONOTONIC: "1"
  };
};
