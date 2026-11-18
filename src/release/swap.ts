import { clearDrainMarker, drainForRelease, resumeAfterFailedDeploy, resumeDrained, type DrainOutcome } from "./drainPhase.js";
import type { ReleasePaths } from "./ledger.js";
import type { DeployedRelease, ReleaseDependencies, ReleaseRequest } from "./releaseTypes.js";
import { ReleaseError } from "./types.js";

import { drainTargetsFor } from "./drainTargets.js";
import type { RuntimeControlTarget } from "./drainControl.js";
import { getRuntimeOperations, listRuntimeAdapters } from "../runtime/registry.js";

/** Compatibility view of registered drain contracts. */
export const DRAINABLE_RUNTIMES: ReadonlySet<string> = new Set(
  listRuntimeAdapters().filter((name) => getRuntimeOperations(name)?.drain)
);

export interface PreparedDrain {
  containerRef: string;
  imageRef: string;
  targets: readonly RuntimeControlTarget[];
}

/** `up --image` names the deployment's container this way; a release replaces exactly that container. */
export const releaseContainerName = (deployment: string): string => `spawnfile-${deployment}`;

export type SwapOutcome = { deployed: DeployedRelease; drained: DrainOutcome; kind: "deployed" } | { drained: DrainOutcome; kind: "deferred" };

/**
 * Drain and swap. The caller holds the deployment's home lock, so no
 * concurrent `up` can replace the drained container between the drain and
 * the deploy. The container is inspected again under the lock (a long build may have outlived
 * the first inspection) and once more after the drain: a different container,
 * or one that restarted and therefore admits again, aborts the release.
 */
export const drainAndSwap = async (
  request: ReleaseRequest,
  deps: ReleaseDependencies,
  paths: ReleasePaths,
  imageTag: string,
  prepared?: PreparedDrain
): Promise<SwapOutcome> => {
  const containerName = releaseContainerName(request.deployment);
  const target = await deps.inspectUnit(request, containerName);
  const targets = request.drain && target?.running
    ? prepared?.containerRef === target.id && prepared.imageRef === target.imageId
      ? prepared.targets : await drainTargetsFor(request, deps, target)
    : [];
  const drained = await drainForRelease(request, deps, paths, target, targets);
  if (drained.kind === "timeout") return { drained, kind: "deferred" };
  if (drained.kind === "drained" && target) {
    // Anything that stops the release between the drain and the deploy resumes the drained container.
    try {
      const now = await deps.inspectUnit(request, containerName);
      if (now === null || now.id !== target.id || now.restartCount !== target.restartCount || !now.running) {
        throw new ReleaseError("drain-failed", "the drained container was replaced or restarted before the deploy; a restarted runtime admits again, so nothing was deployed");
      }
      if (request.signal?.aborted) throw new ReleaseError("interrupted", "the release was interrupted after draining; admission resumed, nothing deployed");
    } catch (error) {
      await resumeDrained(request, deps, paths, target, targets);
      throw error instanceof ReleaseError ? error : new ReleaseError("drain-failed", `cannot confirm the drained container before deploying: ${(error as Error).message}`);
    }
  }
  let deployed: DeployedRelease;
  try {
    deployed = await deps.deploy(request, imageTag);
  } catch (error) {
    if (drained.kind === "drained") await resumeAfterFailedDeploy(request, deps, paths, containerName, targets);
    throw new ReleaseError("deploy-failed", `deploy failed: ${(error as Error).message}`, { cause: error });
  }
  // The drained container was replaced; its drain ended with its process.
  await clearDrainMarker(paths);
  return { deployed, drained, kind: "deployed" };
};
