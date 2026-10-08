import { readFile, rm } from "node:fs/promises";

import { resolveDockerBaseArgs } from "../distribution/index.js";

import type { RuntimeControlTarget } from "./drainControl.js";
import { writeJsonAtomic, type ReleasePaths } from "./ledger.js";
import type { RunningUnit } from "./releaseDocker.js";
import { DAIMON_CONTROL_TOKEN_ENV, type ReleaseDependencies, type ReleaseRequest } from "./releaseTypes.js";
import { ReleaseError } from "./types.js";

export const RELEASE_DRAIN_MARKER_VERSION = "spawnfile.release-drain.v1" as const;

interface DrainMarker {
  container: string;
  /** The Docker context the drain went out through; recovery must use the same target. */
  context: string | null;
  image: string;
  since: string;
  version: typeof RELEASE_DRAIN_MARKER_VERSION;
}

/** Same precedence `up` applies: a process value overrides the env file. */
export const resolveControlToken = (request: ReleaseRequest): string | null => {
  const fromProcess = process.env[DAIMON_CONTROL_TOKEN_ENV];
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  const fromFile = request.envFileEnv[DAIMON_CONTROL_TOKEN_ENV];
  return typeof fromFile === "string" && fromFile.length > 0 ? fromFile : null;
};

export const controlTargetFor = (request: ReleaseRequest, containerRef: string, imageRef: string): RuntimeControlTarget => {
  const token = resolveControlToken(request);
  if (token === null) {
    throw new ReleaseError("blocked", `${DAIMON_CONTROL_TOKEN_ENV} is not set in the env file or environment; a drained release needs the running deployment's control token`);
  }
  return {
    containerRef,
    dockerArgs: resolveDockerBaseArgs({ dockerContext: request.dockerContext }),
    dockerCommand: request.dockerCommand,
    imageRef,
    token
  };
};

/**
 * Written BEFORE the drain request and removed only once admission is open
 * again, so a release killed in between (a unit timeout, a reboot) leaves
 * evidence that the organization may still be refusing work. Every later run
 * resumes it first, even when it has nothing to release.
 */
const writeMarker = async (request: ReleaseRequest, paths: ReleasePaths, unit: RunningUnit): Promise<void> => {
  const marker: DrainMarker = { container: unit.id, context: request.dockerContext ?? null, image: unit.imageId, since: new Date().toISOString(), version: RELEASE_DRAIN_MARKER_VERSION };
  await writeJsonAtomic(paths.drainMarker, marker);
};

export const clearDrainMarker = async (paths: ReleasePaths): Promise<void> => {
  await rm(paths.drainMarker, { force: true });
};

export const recoverInterruptedDrain = async (request: ReleaseRequest, deps: ReleaseDependencies, paths: ReleasePaths): Promise<boolean> => {
  let marker: DrainMarker;
  try {
    marker = JSON.parse(await readFile(paths.drainMarker, "utf8")) as DrainMarker;
    if (typeof marker.container !== "string" || (marker.context !== null && typeof marker.context !== "string")) throw new Error("shape");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ReleaseError("resume-failed", `the drain marker ${paths.drainMarker} is unreadable; the organization may still be drained`);
  }
  // Recovery talks to the Docker target the drain went out through, whatever this run was invoked with.
  const target: ReleaseRequest = { ...request, ...(marker.context === null ? { dockerContext: undefined } : { dockerContext: marker.context }) };
  let unit: RunningUnit | null;
  try {
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
    await deps.requestResume(controlTargetFor(target, unit.id, unit.imageId));
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
  unit: RunningUnit | null
): Promise<DrainOutcome> => {
  if (!request.drain) {
    request.log("release: --no-drain: deploying without draining; in-flight turns will be killed");
    return { drainMs: 0, kind: "skipped" };
  }
  if (unit === null || !unit.running) {
    request.log("release: no running container, so no turn can be in flight; nothing to drain");
    return { drainMs: 0, kind: "skipped" };
  }
  const target = controlTargetFor(request, unit.id, unit.imageId);
  const started = Date.now();
  await writeMarker(request, paths, unit);
  try {
    await deps.requestDrain(target);
    request.log(`release: admission paused; waiting up to ${Math.round(request.drainTimeoutMs / 1000)}s for running turns to finish`);
    const waited = await deps.waitForDrained(target, {
      pollMs: request.drainPollMs,
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs: request.drainTimeoutMs
    });
    if (waited.drained && !request.signal?.aborted) {
      request.log(`release: drained after ${Math.round(waited.waitedMs / 1000)}s`);
      return { drainMs: Date.now() - started, kind: "drained" };
    }
    await resumeOrThrow(request, deps, paths, target);
    if (waited.drained || waited.reason === "interrupted") throw new ReleaseError("interrupted", "the release was interrupted while waiting for running turns; admission resumed, nothing deployed");
    return { drainMs: Date.now() - started, kind: "timeout" };
  } catch (error) {
    if (error instanceof ReleaseError && (error.reason === "interrupted" || error.reason === "resume-failed")) throw error;
    await resumeOrThrow(request, deps, paths, target);
    throw error instanceof ReleaseError ? error : new ReleaseError("drain-failed", (error as Error).message);
  }
};

const resumeOrThrow = async (request: ReleaseRequest, deps: ReleaseDependencies, paths: ReleasePaths, target: RuntimeControlTarget): Promise<void> => {
  try {
    await deps.requestResume(target);
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
  containerName: string
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
  await resumeOrThrow(request, deps, paths, controlTargetFor(request, unit.id, unit.imageId));
};
