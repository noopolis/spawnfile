import { readFile, rm } from "node:fs/promises";

import type { DockerDeploymentTarget } from "../deployment/index.js";

import type { RuntimeControlTarget } from "./drainControl.js";
import { drainTargetsFor } from "./drainTargets.js";
import { writeJsonAtomic, type ReleasePaths } from "./ledger.js";
import type { RunningUnit } from "./releaseDocker.js";
import type { ReleaseDependencies, ReleaseRequest } from "./releaseTypes.js";
import { ReleaseError } from "./types.js";

export const RELEASE_DRAIN_MARKER_VERSION = "spawnfile.release-drain.v1" as const;

interface DrainMarker {
  container: string;
  /** The Docker daemon the drain went out through; recovery must reach the same one. */
  target: DockerDeploymentTarget;
  image: string;
  since: string;
  version: typeof RELEASE_DRAIN_MARKER_VERSION;
}

export * from "../runtime/legacyDrainPhase.generated.js";

export const resumeTargets = async (deps: ReleaseDependencies, targets: readonly RuntimeControlTarget[]): Promise<void> => {
  const results = await Promise.allSettled(targets.map((target) => deps.requestResume(target)));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    if (result.value.drain !== null) throw new ReleaseError("resume-failed", "the runtime still reports a drain");
  }
};

/**
 * Written BEFORE the drain request and removed only once admission is open
 * again, so a release killed in between (a unit timeout, a reboot) leaves
 * evidence that the organization may still be refusing work. Every later run
 * resumes it first, even when it has nothing to release.
 */
const writeMarker = async (request: ReleaseRequest, paths: ReleasePaths, unit: RunningUnit): Promise<void> => {
  const target = request.target;
  if (target === undefined) throw new ReleaseError("blocked", "the release has no pinned Docker target to record with its drain");
  const marker: DrainMarker = { container: unit.id, image: unit.imageId, since: new Date().toISOString(), target, version: RELEASE_DRAIN_MARKER_VERSION };
  await writeJsonAtomic(paths.drainMarker, marker);
};

/** The same request, addressed at exactly this Docker daemon. */
export const requestForTarget = (request: ReleaseRequest, target: DockerDeploymentTarget): ReleaseRequest => {
  const { dockerContext: _context, dockerHost: _host, ...rest } = request;
  if (target.kind === "host") return { ...rest, dockerHost: target.value, target };
  return { ...rest, dockerContext: target.kind === "context" ? target.name : target.context, target };
};

export const clearDrainMarker = async (paths: ReleasePaths): Promise<void> => {
  await rm(paths.drainMarker, { force: true });
};

export const recoverInterruptedDrain = async (request: ReleaseRequest, deps: ReleaseDependencies, paths: ReleasePaths): Promise<boolean> => {
  let marker: DrainMarker;
  try {
    marker = JSON.parse(await readFile(paths.drainMarker, "utf8")) as DrainMarker;
    if (typeof marker.container !== "string" || typeof marker.target?.kind !== "string") throw new Error("shape");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ReleaseError("resume-failed", `the drain marker ${paths.drainMarker} is unreadable; the organization may still be drained`);
  }
  // Recovery talks to the Docker daemon the drain went out through, whatever this run was invoked with,
  // and refuses (keeping the marker) when that name now resolves to a different endpoint.
  const target = requestForTarget(request, marker.target);
  let unit: RunningUnit | null;
  try {
    await deps.verifyTarget(target, marker.target);
    unit = await deps.inspectUnit(target, marker.container);
  } catch (error) {
    throw new ReleaseError("resume-failed", `an earlier release may have left the organization drained and its container cannot be inspected: ${(error as Error).message}`);
  }
  if (unit === null || !unit.running) {
    // A drain lives in the runtime process: a container that is gone or stopped admits again when it next starts.
    await clearDrainMarker(paths);
    return true;
  }
  try {
    if (unit.imageId !== marker.image) throw new Error("the marked container no longer matches the drained image");
    await resumeTargets(deps, await drainTargetsFor(target, deps, unit));
  } catch (error) {
    throw new ReleaseError("resume-failed", `an earlier release left the organization drained and resuming it failed: ${(error as Error).message}`);
  }
  await clearDrainMarker(paths);
  request.log("release: resumed admission left drained by an interrupted release");
  return true;
};

export type DrainOutcome = { drainMs: number; kind: "drained" } | { drainMs: number; kind: "skipped" } | { drainMs: number; kind: "timeout" };

/**
 * Admission pauses, queued wakes stay queued, running turns finish. On a
 * timeout or interruption the release is abandoned and admission resumed:
 * nothing in this module, or anything it calls, stops a turn.
 */
export const drainForRelease = async (
  request: ReleaseRequest,
  deps: ReleaseDependencies,
  paths: ReleasePaths,
  unit: RunningUnit | null,
  prepared?: readonly RuntimeControlTarget[]
): Promise<DrainOutcome> => {
  if (!request.drain) {
    request.log("release: --no-drain: deploying without draining; in-flight turns will be killed");
    return { drainMs: 0, kind: "skipped" };
  }
  if (unit === null || !unit.running) {
    request.log("release: no running container, so no turn can be in flight; nothing to drain");
    return { drainMs: 0, kind: "skipped" };
  }
  const targets = prepared ?? await drainTargetsFor(request, deps, unit);
  const started = Date.now();
  await writeMarker(request, paths, unit);
  try {
    for (const target of targets) {
      const { drain } = await deps.requestDrain(target);
      if (drain === null) throw new ReleaseError("drain-failed", "the runtime did not confirm an admission drain");
    }
    request.log(`release: admission paused; waiting up to ${Math.round(request.drainTimeoutMs / 1000)}s for running turns to finish`);
    const timings = await Promise.all(targets.map((target) => deps.waitForDrained(target, {
      pollMs: request.drainPollMs,
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs: request.drainTimeoutMs
    })));
    const waitFailed = timings.find((timing) => !timing.drained);
    if (waitFailed === undefined && !request.signal?.aborted) {
      const waitedMs = Math.max(...timings.map((timing) => timing.waitedMs));
      request.log(`release: drained after ${Math.round(waitedMs / 1000)}s`);
      return { drainMs: Date.now() - started, kind: "drained" };
    }
    await resumeOrThrow(request, deps, paths, () => targets);
    if (request.signal?.aborted || waitFailed?.reason === "interrupted") throw new ReleaseError("interrupted", "the release was interrupted while waiting for running turns; admission resumed, nothing deployed");
    return { drainMs: Date.now() - started, kind: "timeout" };
  } catch (error) {
    if (error instanceof ReleaseError && (error.reason === "interrupted" || error.reason === "resume-failed")) throw error;
    await resumeOrThrow(request, deps, paths, () => targets);
    throw error instanceof ReleaseError ? error : new ReleaseError("drain-failed", (error as Error).message);
  }
};

/** Resumes a container this release drained, keeping the marker if that fails. */
export const resumeDrained = async (
  request: ReleaseRequest, deps: ReleaseDependencies, paths: ReleasePaths, unit: RunningUnit,
  prepared?: readonly RuntimeControlTarget[]
): Promise<void> =>
  resumeOrThrow(request, deps, paths, () => prepared ?? drainTargetsFor(request, deps, unit));

const resumeOrThrow = async (
  request: ReleaseRequest, deps: ReleaseDependencies, paths: ReleasePaths,
  targets: () => Promise<RuntimeControlTarget[]> | readonly RuntimeControlTarget[]
): Promise<void> => {
  try {
    await resumeTargets(deps, await targets());
  } catch (error) {
    throw new ReleaseError("resume-failed", `admission could not be resumed after abandoning the release; the organization is refusing new work: ${(error as Error).message}`);
  }
  await clearDrainMarker(paths);
  request.log("release: admission resumed");
};

/**
 * After a failed deploy, whatever container now holds the name is either the
 * restored previous one (restarted, so it admits) or the original, still
 * drained because the deploy failed before touching it. Resume either way.
 */
export const resumeAfterFailedDeploy = async (
  request: ReleaseRequest,
  deps: ReleaseDependencies,
  paths: ReleasePaths,
  containerName: string,
  prepared?: readonly RuntimeControlTarget[]
): Promise<void> => {
  let unit: RunningUnit | null;
  try {
    unit = await deps.inspectUnit(request, containerName);
  } catch (error) {
    // Not "absent": the marker stays, so the next run resumes it.
    throw new ReleaseError("resume-failed", `the deploy failed and the container cannot be inspected to resume admission: ${(error as Error).message}`);
  }
  if (unit === null || !unit.running) {
    await clearDrainMarker(paths);
    return;
  }
  const reusable = prepared?.every((target) => target.containerRef === unit.id && target.imageRef === unit.imageId)
    ? prepared
    : undefined;
  await resumeOrThrow(request, deps, paths, () => reusable ?? drainTargetsFor(request, deps, unit, { requireAll: false }));
};
