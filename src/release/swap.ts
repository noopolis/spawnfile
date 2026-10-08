import { clearDrainMarker, drainForRelease, resumeAfterFailedDeploy, resumeDrained, type DrainOutcome } from "./drainPhase.js";
import type { ReleasePaths } from "./ledger.js";
import type { DeployedRelease, ReleaseDependencies, ReleaseRequest } from "./releaseTypes.js";
import { ReleaseError } from "./types.js";

/** Runtimes whose admission a release can pause through a published control contract. */
export const DRAINABLE_RUNTIMES: ReadonlySet<string> = new Set(["daimon"]);

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
  imageTag: string
): Promise<SwapOutcome> => {
  const containerName = releaseContainerName(request.deployment);
  const target = await deps.inspectUnit(request, containerName);
  if (request.drain && target?.running) {
    const runtimes = await deps.runtimesOf(request, target.imageId).catch((error: unknown) => {
      throw new ReleaseError("blocked", `cannot read which runtimes the running image holds, so it cannot be shown drainable: ${(error as Error).message}`);
    });
    const undrainable = [...new Set(runtimes)].filter((runtime) => !DRAINABLE_RUNTIMES.has(runtime));
    if (runtimes.length === 0 || undrainable.length > 0) {
      throw new ReleaseError("blocked", `the running container holds runtimes without a drain contract (${undrainable.join(", ") || "none listed"}); draining it could not stop their turns. Use --no-drain to deploy over them deliberately`);
    }
  }
  const drained = await drainForRelease(request, deps, paths, target);
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
      await resumeDrained(request, deps, paths, target);
      throw error instanceof ReleaseError ? error : new ReleaseError("drain-failed", `cannot confirm the drained container before deploying: ${(error as Error).message}`);
    }
  }
  let deployed: DeployedRelease;
  try {
    deployed = await deps.deploy(request, imageTag);
  } catch (error) {
    await resumeAfterFailedDeploy(request, deps, paths, containerName);
    throw new ReleaseError("deploy-failed", `deploy failed: ${(error as Error).message}`, { cause: error });
  }
  // The drained container was replaced; its drain ended with its process.
  await clearDrainMarker(paths);
  return { deployed, drained, kind: "deployed" };
};
