import { performance } from "node:perf_hooks";

import {
  buildCompiledProject,
  createDefaultImageTag,
  resolveDockerBuildArchitecture,
  resolveImageTagRoot
} from "../compiler/buildProject.js";
import { compileProject } from "../compiler/compileProject.js";
import { createDockerBuildContextDigest } from "../compiler/dockerBuildContext.js";
import { inspectDockerImage } from "../compiler/dockerBuildSkip.js";
import { requireAuthProfile } from "../auth/index.js";
import { readRunEnvFile } from "../compiler/runProjectAuth.js";
import { acquireHomeDeploymentLock, resolveDockerDeploymentTarget, verifyDockerDeploymentTarget } from "../deployment/index.js";
import { consumeImageUp, createConsumerDockerRunner, extractImageReport, resolveDockerBaseArgs } from "../distribution/index.js";
import type { DockerCommandRunner } from "../distribution/dockerRunner.js";

import { helperControlCall, requestDrain, requestResume, waitForDrained } from "./drainControl.js";
import { sendNotification } from "./notify.js";
import { inspectUnit, pruneReleaseImages, settleUnit } from "./releaseDocker.js";
import type { ReleaseDependencies, ReleaseRequest } from "./releaseTypes.js";

const dockerFor = (request: ReleaseRequest): DockerCommandRunner =>
  createConsumerDockerRunner(request.dockerCommand, resolveDockerBaseArgs({
    ...(request.dockerContext ? { dockerContext: request.dockerContext } : {}),
    ...(request.dockerHost ? { dockerHost: request.dockerHost } : {})
  }));

/**
 * The production effects. The identity is the Docker build-context digest the
 * build cache already keys on: a function of everything the image is built
 * from (compiled workspaces, bundles, runtime installs, target architecture),
 * so a change that does not reach the image does not release, and one that
 * does always does.
 */
export const createDefaultReleaseDependencies = (): ReleaseDependencies => ({
  async build(request, compiled, imageTag) {
    const result = await buildCompiledProject(request.inputPath, compiled.compileResult, {
      contextDigest: compiled.identity,
      dockerCommand: request.dockerCommand,
      ...(request.dockerContext ? { dockerContext: request.dockerContext } : {}),
      imageTag
    });
    const image = await inspectDockerImage({ dockerCommand: request.dockerCommand, dockerContext: request.dockerContext ?? null, imageTag });
    if (image === null) throw new Error(`built image ${imageTag} cannot be inspected`);
    return { buildMs: result.imageBuild?.buildMs ?? null, imageId: image.id, imageTag, skipped: result.imageBuild?.skipped ?? false };
  },
  async compile(request) {
    const started = performance.now();
    const containerArchitecture = await resolveDockerBuildArchitecture({
      dockerCommand: request.dockerCommand,
      ...(request.dockerContext ? { dockerContext: request.dockerContext } : {})
    });
    const compileResult = await compileProject(request.inputPath, {
      bundleIdentity: request.bundleIdentity,
      ...(containerArchitecture ? { containerArchitecture } : {}),
      ...(request.outputDirectory ? { outputDirectory: request.outputDirectory } : {})
    });
    const identity = await createDockerBuildContextDigest(compileResult.outputDirectory);
    return {
      compileMs: performance.now() - started,
      compileResult,
      identity,
      repository: request.imageRepository ?? createDefaultImageTag(resolveImageTagRoot(request.inputPath))
    };
  },
  async deploy(request, imageTag) {
    const started = performance.now();
    const result = await consumeImageUp(imageTag, {
      authProfile: request.authProfile ?? null,
      authProfileName: request.authProfileName ?? null,
      authValues: request.authProfile?.env ?? {},
      deploymentLockHeld: true,
      deploymentName: request.deployment,
      dockerCommand: request.dockerCommand,
      ...(request.dockerContext ? { dockerContext: request.dockerContext } : {}),
      envFileEnv: request.envFileEnv,
      envFilePath: request.envFilePath ?? null
    });
    return { containerName: result.containerName, deployMs: performance.now() - started };
  },
  inspectUnit: (request, containerRef) => inspectUnit(dockerFor(request), containerRef),
  notify: (config, notification) => sendNotification(config, notification),
  prune: (request, repository, keep) => pruneReleaseImages(dockerFor(request), repository, keep),
  lockDeployment: (deployment) => acquireHomeDeploymentLock(deployment),
  async prepare(request) {
    return {
      authProfile: request.authProfileName ? await requireAuthProfile(request.authProfileName) : null,
      envFileEnv: await readRunEnvFile(request.envFilePath)
    };
  },
  async runtimesOf(request, imageId) {
    const inspection = await extractImageReport(imageId, {
      dockerCommand: request.dockerCommand,
      ...(request.dockerContext ? { dockerContext: request.dockerContext } : {})
    });
    return inspection.report.runtime_instances.map((instance) => instance.runtime);
  },
  requestDrain: (target) => requestDrain(target, helperControlCall),
  resolveTarget: (request) => resolveDockerDeploymentTarget({
    context: request.dockerContext ?? null,
    dockerCommand: request.dockerCommand,
    dockerHost: request.dockerHost ?? null
  }),
  async verifyTarget(request, target) {
    await verifyDockerDeploymentTarget(target, { dockerCommand: request.dockerCommand });
  },
  requestResume: (target) => requestResume(target, helperControlCall),
  settle: (request, containerRef) => settleUnit(dockerFor(request), containerRef, request.settle),
  waitForDrained: (target, options) => waitForDrained(target, { call: helperControlCall, ...options })
});
