import { createDockerTargetExecutors } from "../target/dockerCommandExecutor.js";
import { createDockerWorldClockReader } from "../target/dockerWorldClock.js";
import { initializeWorldServiceAuthorityReader } from "../target/dockerWorldServiceStore.js";
import {
  parseTargetWorldClockRequest,
  type TargetWorldClockReceipt,
} from "../target/worldClock.js";
import type { TargetDefaultWorldReadinessConfig } from "./targetDefaultConfig.js";

/** Query one recorded world and its immutable activation marker for clock truth. */
export const queryTargetDefaultWorldClock = async (
  config: TargetDefaultWorldReadinessConfig,
  request: unknown,
): Promise<TargetWorldClockReceipt> => {
  const parsed = parseTargetWorldClockRequest(request);
  const authorityStore = await initializeWorldServiceAuthorityReader(config.paths.worldAuthority);
  const executors = createDockerTargetExecutors({ dockerCommand: config.dockerCommand });
  return createDockerWorldClockReader({
    authorityStore, context: config.context, contentExecutor: executors.publicArtifact,
    executor: executors.world, timeoutMs: config.timeoutMs,
  }).query(parsed);
};
