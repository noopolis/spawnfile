import type { DeploymentRecord } from "../deployment/index.js";

import { clearDrainMarker, controlTargetFor, drainForRelease, recoverInterruptedDrain, resolveControlToken, resumeAfterFailedDeploy } from "./drainPhase.js";
import {
  acquireReleaseLock,
  appendReleaseLog,
  ensureReleaseDirectory,
  readReleaseLedger,
  resolveReleasePaths,
  writeReleaseLedger,
  type ReleaseLedger,
  type ReleasePaths
} from "./ledger.js";
import { createNotification } from "./notify.js";
import { clearDeferral, recordDeferral } from "./pending.js";
import { releaseImageTag, type RunningUnit } from "./releaseDocker.js";
import { DAIMON_CONTROL_TOKEN_ENV, type ReleaseDependencies, type ReleaseRequest } from "./releaseTypes.js";
import { ReleaseError, isReleaseError, type ReleaseFailureReason, type ReleaseOutcome, type ReleaseTimings } from "./types.js";

const containerUnit = (record: DeploymentRecord | null): DeploymentRecord["units"][number] | null =>
  record?.units.find((unit) => unit.kind === "container") ?? null;

const containerNameFor = (deployment: string, record: DeploymentRecord | null): string =>
  containerUnit(record)?.container_name ?? `spawnfile-${deployment}`;

interface Progress {
  identity: string | null;
  stage: string;
}

/**
 * compile → identity → (unchanged? stop) → build → drain → deploy → settle →
 * resume → record → prune. The ledger is written last because it claims
 * "this identity is RUNNING"; written earlier it would claim a container that
 * never came up, and the next run would see nothing to do.
 */
export const runRelease = async (request: ReleaseRequest, deps: ReleaseDependencies): Promise<ReleaseOutcome> => {
  const paths = resolveReleasePaths(request.deployment, request.releaseRoot);
  const progress: Progress = { identity: null, stage: "lock" };
  let unlock: (() => Promise<void>) | null = null;
  try {
    await ensureReleaseDirectory(paths);
    unlock = await acquireReleaseLock(paths);
    progress.stage = "recover";
    await recoverInterruptedDrain(request, deps, paths);
    return await releaseLocked(request, deps, paths, progress);
  } catch (error) {
    return fail(request, deps, paths, progress, error);
  } finally {
    await unlock?.().catch(() => undefined);
  }
};

const releaseLocked = async (
  request: ReleaseRequest,
  deps: ReleaseDependencies,
  paths: ReleasePaths,
  progress: Progress
): Promise<ReleaseOutcome> => {
  const started = Date.now();
  progress.stage = "compile";
  const compiled = await deps.compile(request).catch((error: unknown) => {
    throw new ReleaseError("build-failed", `compile failed: ${(error as Error).message}`, { cause: error });
  });
  progress.identity = compiled.identity;
  const imageTag = releaseImageTag(compiled.repository, compiled.identity);

  progress.stage = "inspect";
  const ledger = await readReleaseLedger(paths.ledger);
  const record = await deps.readDeployment(request.deployment);
  const containerName = containerNameFor(request.deployment, record);
  const running = await deps.inspectUnit(request, containerUnit(record)?.container_id ?? containerName);

  if (isUnchanged(request, ledger, compiled.identity, running)) {
    await clearDeferral(paths.pending);
    request.log(`release: ${compiled.identity.slice(0, 19)} is already running as ${ledger!.image_tag}; nothing to do`);
    return { identity: compiled.identity, imageTag: ledger!.image_tag, kind: "unchanged" };
  }
  if (request.drain && running?.running && resolveControlToken(request) === null) {
    throw new ReleaseError("blocked", `${DAIMON_CONTROL_TOKEN_ENV} is not set in the env file or environment; a drained release needs the running deployment's control token`);
  }
  request.log(ledger
    ? `release: ${compiled.identity.slice(0, 19)} differs from the released ${ledger.identity.slice(0, 19)} (${ledger.image_tag}); releasing`
    : `release: nothing recorded as released for ${request.deployment}; releasing ${compiled.identity.slice(0, 19)}`);

  // The tag about to be built is kept too: a retry after a failed deploy reuses it instead of rebuilding.
  await pruneQuietly(request, deps, compiled.repository, [imageTag, ledger?.image_tag ?? null, ledger?.previous_image_tag ?? null]);

  progress.stage = "build";
  const built = await deps.build(request, compiled, imageTag).catch((error: unknown) => {
    throw new ReleaseError("build-failed", `image build failed: ${(error as Error).message}`, { cause: error });
  });
  request.log(built.skipped ? `release: ${imageTag} already built; build skipped` : `release: built ${imageTag} in ${Math.round((built.buildMs ?? 0) / 1000)}s`);

  progress.stage = "drain";
  if (request.signal?.aborted) throw new ReleaseError("interrupted", "the release was interrupted before draining; nothing was paused or deployed");
  const drained = await drainForRelease(request, deps, paths, running);
  if (drained.kind === "timeout") return defer(request, deps, paths, compiled.identity);

  progress.stage = "deploy";
  let deployed;
  try {
    deployed = await deps.deploy(request, imageTag);
  } catch (error) {
    await resumeAfterFailedDeploy(request, deps, paths, containerName);
    throw new ReleaseError("deploy-failed", `deploy failed: ${(error as Error).message}`, { cause: error });
  }
  // The drained container was replaced; its drain ended with its process.
  await clearDrainMarker(paths);

  progress.stage = "settle";
  const settled = await deps.settle(request, deployed.containerName);
  if (request.drain) {
    progress.stage = "resume";
    try {
      await deps.requestResume(controlTargetFor(request, settled.id, settled.imageId));
    } catch (error) {
      throw new ReleaseError("resume-failed", `the new container did not confirm admission: ${(error as Error).message}`);
    }
  }

  progress.stage = "record";
  const timings: ReleaseTimings = {
    build_ms: built.buildMs,
    compile_ms: compiled.compileMs,
    deploy_ms: deployed.deployMs,
    drain_ms: drained.drainMs,
    total_ms: Date.now() - started
  };
  const next: ReleaseLedger = {
    compile_fingerprint: compiled.compileResult.report.compile_fingerprint ?? "unknown",
    deployment: request.deployment,
    identity: compiled.identity,
    image_id: settled.imageId,
    image_tag: imageTag,
    previous_image_tag: ledger && ledger.image_tag !== imageTag ? ledger.image_tag : ledger?.previous_image_tag ?? null,
    released_at: (request.now?.() ?? new Date()).toISOString(),
    timings,
    version: "spawnfile.release-ledger.v1"
  };
  await writeReleaseLedger(paths.ledger, next).catch((error: unknown) => {
    throw new ReleaseError("ledger-failed", `the deployment is running but the release ledger could not be written (every later run will redeploy until it can): ${(error as Error).message}`);
  });
  await appendReleaseLog(paths.log, { at: next.released_at, deployment: request.deployment, identity: compiled.identity, image_tag: imageTag, outcome: "released", timings }).catch(() => undefined);
  await clearDeferral(paths.pending).catch(() => undefined);
  await pruneQuietly(request, deps, compiled.repository, [imageTag, next.previous_image_tag]);
  request.log(`release: ${imageTag} deployed, settled and recorded (build ${timings.build_ms === null ? "skipped" : `${Math.round(timings.build_ms / 1000)}s`}, drain ${Math.round((timings.drain_ms ?? 0) / 1000)}s, total ${Math.round(timings.total_ms / 1000)}s)`);
  return { identity: compiled.identity, imageId: settled.imageId, imageTag, kind: "released", timings };
};

/** Unchanged means the recorded identity is the one the container is actually running, not merely the one last built. */
const isUnchanged = (request: ReleaseRequest, ledger: ReleaseLedger | null, identity: string, running: RunningUnit | null): boolean =>
  !request.force && ledger !== null && ledger.identity === identity && running !== null && running.running && running.imageId === ledger.image_id;

const pruneQuietly = async (request: ReleaseRequest, deps: ReleaseDependencies, repository: string, keep: (string | null)[]): Promise<void> => {
  try {
    const pruned = await deps.prune(request, repository, keep);
    for (const tag of pruned.removed) request.log(`release: removed old image ${tag}`);
  } catch (error) {
    request.log(`release: image prune skipped (${(error as Error).message.slice(0, 160)})`);
  }
};

const defer = async (request: ReleaseRequest, deps: ReleaseDependencies, paths: ReleasePaths, identity: string): Promise<ReleaseOutcome> => {
  const decision = await recordDeferral(paths.pending, identity, { notifyAfterMs: request.notifyDeferredAfterMs, ...(request.now ? { now: request.now() } : {}) });
  const hours = Math.floor(decision.ageMs / 3_600_000);
  const message = decision.trackingBroken
    ? `release deferred (running turns did not finish within the drain bound) and ${decision.trackingBroken}`
    : `release deferred: running turns did not finish within the drain bound; pending ${hours}h`;
  request.log(`release: ${message}; admission resumed, nothing deployed, retry on the next run`);
  const at = (request.now?.() ?? new Date()).toISOString();
  await appendReleaseLog(paths.log, { at, deployment: request.deployment, identity, message, outcome: "deferred", reason: "release-deferred" }).catch(() => undefined);
  const notified = decision.notify ? await notifyAndLog(request, deps, paths, "release-deferred", message, identity) : false;
  return { identity, kind: "deferred", message, notified };
};

const fail = async (
  request: ReleaseRequest,
  deps: ReleaseDependencies,
  paths: ReleasePaths,
  progress: Progress,
  error: unknown
): Promise<ReleaseOutcome> => {
  const reason: ReleaseFailureReason = isReleaseError(error) ? error.reason : "blocked";
  const message = `${reason} at ${progress.stage}: ${error instanceof Error ? error.message : String(error)}`;
  request.log(`release FAILED: ${message}`);
  const at = (request.now?.() ?? new Date()).toISOString();
  await appendReleaseLog(paths.log, { at, deployment: request.deployment, identity: progress.identity, message, outcome: "failed", reason }).catch(() => undefined);
  const notified = await notifyAndLog(request, deps, paths, reason, message, progress.identity);
  return { identity: progress.identity, kind: "failed", message, notified, reason };
};

const notifyAndLog = async (
  request: ReleaseRequest,
  deps: ReleaseDependencies,
  paths: ReleasePaths,
  reason: ReleaseFailureReason,
  message: string,
  identity: string | null
): Promise<boolean> => {
  if (request.notifier.kind === "none") return false;
  const notification = createNotification({ deployment: request.deployment, identity, message, reason, ...(request.now ? { now: request.now() } : {}) });
  const result = await deps.notify(request.notifier, notification).catch((error: unknown) => ({ channel: request.notifier.kind, delivered: false, error: (error as Error).message }));
  if (!result.delivered) request.log(`release: notifier did not deliver (${result.error ?? "unknown"}); the message is in ${paths.log}`);
  await appendReleaseLog(paths.log, {
    at: notification.at, deployment: request.deployment, identity, message: notification.message,
    notified: { channel: result.channel, delivered: result.delivered, ...(result.error ? { error: result.error } : {}) },
    outcome: "notified", reason
  }).catch(() => undefined);
  return result.delivered;
};
