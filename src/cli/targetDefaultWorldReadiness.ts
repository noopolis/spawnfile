import { createDockerWorldReadinessReader } from "../target/dockerWorldReadiness.js";
import { createDockerTargetExecutors } from "../target/dockerCommandExecutor.js";
import { initializeWorldServiceAuthorityReader } from "../target/dockerWorldServiceStore.js";
import {
  parseTargetWorldReadinessRequest,
  type TargetWorldReadinessReceipt,
  type TargetWorldReadinessRequest
} from "../target/worldReadiness.js";
import type { TargetDefaultWorldReadinessConfig } from "./targetDefaultConfig.js";

/** Query one exact world through its private container-local readiness endpoint. */
export const queryTargetDefaultWorldReadiness = async (
  config: TargetDefaultWorldReadinessConfig,
  request: unknown
): Promise<TargetWorldReadinessReceipt> => {
  const parsedRequest: TargetWorldReadinessRequest = parseTargetWorldReadinessRequest(request);
  const authorityStore = await initializeWorldServiceAuthorityReader(
    config.paths.worldAuthority
  );
  const executors = createDockerTargetExecutors({ dockerCommand: config.dockerCommand });
  return createDockerWorldReadinessReader({
    authorityStore,
    context: config.context,
    contentExecutor: executors.publicArtifact,
    executor: executors.world,
    timeoutMs: config.timeoutMs
  }).query(parsedRequest);
};
