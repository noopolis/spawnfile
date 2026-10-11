import { instantNanos, normalizeInstant } from "./instant.js";
import { taskClockSchema } from "./contract.js";

/** Shared ecosystem range applies to trial instants, not historical source timestamps. */
export const assertTaskClockInstant = (instant: string): void => {
  const nanos = instantNanos(instant);
  if (nanos < 0n || nanos > 253_402_300_799_999_000_000n) {
    throw new Error(`Trial instant ${instant} must be within 1970-01-01T00:00:00Z .. 9999-12-31T23:59:59.999Z`);
  }
};
const taskOrigin = (origin: string): string => {
  assertTaskClockInstant(origin);
  return normalizeInstant(origin);
};
export const createTaskClock = (origin: string) => taskClockSchema.parse({
  version: "spawnfile.task-clock.v1", origin: taskOrigin(origin)
});
const clockOrigin = (origin: string, anchorEpochMs: number): string => {
  if (!Number.isSafeInteger(anchorEpochMs)) throw new Error("Task clock anchorEpochMs must be a safe integer");
  return taskOrigin(origin);
};

/** Top-level Daimon only: its clock stays real and it derives each child's clock environment. */
export const harnessTaskClockEnvironment = (origin: string, anchorEpochMs: number): Record<string, string> => ({
  NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: clockOrigin(origin, anchorEpochMs), anchorEpochMs })
});

/** Child/tool wall clock. Trial preparation supplies libfaketime LD_PRELOAD and a dot-decimal locale. */
export const processClockEnvironment = (origin: string, anchorEpochMs: number): Record<string, string> => {
  const normalized = clockOrigin(origin, anchorEpochMs);
  const offsetMs = BigInt(Date.parse(normalized)) - BigInt(anchorEpochMs);
  const magnitude = offsetMs < 0n ? -offsetMs : offsetMs;
  const fraction = magnitude % 1000n;
  return {
    FAKETIME: `${offsetMs < 0n ? "-" : "+"}${magnitude / 1000n}${fraction ? `.${String(fraction).padStart(3, "0")}` : ""}`,
    FAKETIME_DONT_FAKE_MONOTONIC: "1"
  };
};

/** Clock-aware child (e.g. Mneme) without libfaketime: apply the offset inside the process exactly once. */
export const clockAwareEnvironment = (origin: string, anchorEpochMs: number): Record<string, string> => ({
  MNEME_CLOCK_ORIGIN: clockOrigin(origin, anchorEpochMs), MNEME_CLOCK_ANCHOR_MS: String(anchorEpochMs)
});
