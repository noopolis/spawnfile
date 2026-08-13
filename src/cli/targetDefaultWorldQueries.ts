import type { TargetWorldClockRequest } from "../target/worldClock.js";
import type { TargetWorldReadinessRequest } from "../target/worldReadiness.js";
import type { TargetDefaultWorldReadinessConfig } from "./targetDefaultConfig.js";
import type { TargetWorldClockSession } from "./targetWorldClockCommand.js";
import type { TargetWorldReadinessSession } from "./targetWorldReadinessCommand.js";

/** Minimal production session shared by the two read-only world queries. */
export const createProductionTargetWorldQuerySession = (
  config: TargetDefaultWorldReadinessConfig,
): TargetWorldReadinessSession & TargetWorldClockSession => Object.freeze({
  queryWorldReadiness: async (request: TargetWorldReadinessRequest) => {
    const { queryTargetDefaultWorldReadiness } = await import("./targetDefaultWorldReadiness.js");
    return queryTargetDefaultWorldReadiness(config, request);
  },
  queryWorldClock: async (request: TargetWorldClockRequest) => {
    const { queryTargetDefaultWorldClock } = await import("./targetDefaultWorldClock.js");
    return queryTargetDefaultWorldClock(config, request);
  },
});
