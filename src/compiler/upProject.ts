import path from "node:path";
import { rm } from "node:fs/promises";

import {
  createOrganizationReadinessPending,
  createDockerDeploymentRecord,
  probeDockerOrganizationReadiness,
  readDeploymentRecord,
  resolveDockerDeploymentTarget,
  resolveDeploymentRecordPath,
  type DockerTargetExecFile,
  writeDeploymentRecord,
  writeDockerDeploymentRecordForRun,
} from "../deployment/index.js";
import type { UpLifecycleRecovery } from "../deployment/upLifecycleRecoveryState.js";
import {
  buildProject,
  type BuildProjectResult,
  type DockerBuildRunner
} from "./buildProject.js";
import {
  createDockerRunInvocation,
  resolveDetachedDeploymentOptions,
  runDockerContainer,
  type DockerRunResult,
  type DockerRunRunner
} from "./runProject.js";
import { executeDockerRunWithSupportCleanup } from "./runProjectLifecycle.js";
import { requireAuthProfile } from "../auth/index.js";
import { CompileProjectOptions } from "./compileProject.js";
import { DEFAULT_OUTPUT_DIRECTORY, SpawnfileError } from "../shared/index.js";
import { ensureNoopolisRunId, resolveNoopolisRunId } from "../runtime/index.js";
import { fileExists } from "../filesystem/index.js";
import { resolveHostCliCredential } from "./runProjectAuth.js";
import {
  compileOrganizationHandoff,
  executeOrganizationHandoff,
  organizationHandoffInputError,
  resolveRequestedOrganizationHandoff,
  verifyRequestedOrganizationHandoffTarget,
} from "./upProjectHandoff.js";
export interface UpProjectOptions extends CompileProjectOptions {
  authProfile?: string;
  buildRunner?: DockerBuildRunner;
  containerName?: string;
  detach?: boolean;
  deploymentName?: string;
  dockerCommand?: string;
  dockerContext?: string;
  dockerHost?: string;
  envFilePath?: string;
  imageTag?: string;
  lifecycleRecovery?: UpLifecycleRecovery;
  runRunner?: DockerRunRunner;
  onDetachedReservation?: (authority: {
    containerName: string;
    deploymentLabels: Readonly<Record<string, string>>;
    dockerCommand: string;
    dockerContext: string | null;
  }) => Promise<void>;
  onDetachedStarted?: (result: DockerRunResult & { containerId: string; containerName: string; imageId: string; deploymentLabels: Readonly<Record<string, string>> }) => Promise<void>;
  networkAttachmentHandle?: string;
  organizationHandoffRunId?: string;
  descriptorDigest?: string;
  selectedTargetReceipt?: unknown;
  selectedTargetReceiptDigest?: string;
  targetExecFile?: DockerTargetExecFile;
}

export interface UpProjectResult extends BuildProjectResult {
  authProfileName: string | null;
  containerName: string | null;
  deploymentRecordPath?: string | null;
  supportDirectory: string | null;
}
const stableRecord = (record: Awaited<ReturnType<typeof readDeploymentRecord>>) => {
  const { created_at: _createdAt, export_index: _exportIndex, organization_ready: _organizationReady, ...stable } = record;
  return stable;
};
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw organizationHandoffInputError();
  return serialized;
};

export const upProject = async (
  inputPath: string,
  options: UpProjectOptions = {}
): Promise<UpProjectResult> => {
  // Parse caller authority before any target or build work. Target identity is
  // verified below from the resolved detached options, including exact record reuse.
  const requestedHandoff = resolveRequestedOrganizationHandoff(options);
  // Handoff reservation identity must survive a process crash.  Unlike an
  // ordinary deployment run, it may never silently mint a fresh run id.
  if (requestedHandoff && resolveNoopolisRunId(process.env) !== requestedHandoff.runId) throw organizationHandoffInputError();
  const resolvedOptions = await resolveDetachedDeploymentOptions(
    path.resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY),
    {
      authProfile: options.authProfile,
      containerName: options.containerName,
      deploymentName: options.deploymentName,
      detach: options.detach,
      dockerCommand: options.dockerCommand,
      dockerContext: options.dockerContext,
      dockerHost: options.dockerHost,
      envFilePath: options.envFilePath,
      imageTag: options.imageTag,
      targetExecFile: options.targetExecFile
    }
  );
  await verifyRequestedOrganizationHandoffTarget(requestedHandoff, resolvedOptions, options);
  // Every authority container compiled for this deployment must stamp
  // causal events under the same real run id (see specs/CAUSAL.md).
  // buildProject/compileProject stay deterministic functions of the host
  // env; this only fills in a generated id when the host did not already
  // provide one, before the build step that bakes it into the
  // entrypoint/recipe env.
  if (!requestedHandoff) ensureNoopolisRunId();
  const buildResult = await buildProject(inputPath, {
    buildRunner: options.buildRunner,
    clean: options.clean,
    containerArchitecture: options.containerArchitecture,
    dockerContext: resolvedOptions.dockerContext,
    dockerCommand: options.dockerCommand,
    imageTag: resolvedOptions.imageTag,
    outputDirectory: options.outputDirectory,
    runtimePackageOverrides: options.runtimePackageOverrides,
    ...(options.worldBindingsPath !== undefined
      ? { worldBindingsPath: options.worldBindingsPath }
      : {})
  });
  const handoff = compileOrganizationHandoff(requestedHandoff, buildResult);
  const authProfile = resolvedOptions.authProfile
    ? await requireAuthProfile(resolvedOptions.authProfile)
    : null;
  const cliCredential = await resolveHostCliCredential(buildResult.report.container!);
  const imageTag = resolvedOptions.imageTag ?? buildResult.imageTag;
  const invocation = await createDockerRunInvocation(buildResult, imageTag, {
    authProfile,
    ...(cliCredential ? { cliCredential: { name: cliCredential.name, value: cliCredential.value } } : {}),
    containerName: resolvedOptions.containerName,
    detach: options.detach,
    deploymentName: resolvedOptions.deploymentName,
    dockerCommand: options.dockerCommand,
    dockerContext: resolvedOptions.dockerContext,
    dockerHost: resolvedOptions.dockerHost,
    envFilePath: resolvedOptions.envFilePath
  });
  if (options.onDetachedStarted) {
    const started = options.onDetachedStarted;
    invocation.onDetachedStarted = async (result) => {
      if (!result.containerId || !result.containerName || !result.imageId || !result.deploymentLabels) {
        throw new SpawnfileError("runtime_error", "Detached deployment metadata is incomplete");
      }
      await started({ ...result, containerId: result.containerId, containerName: result.containerName, imageId: result.imageId, deploymentLabels: result.deploymentLabels });
    };
  }

  let deploymentRecordPath: string | null;
  if (handoff) {
    const executed = await executeOrganizationHandoff({
      dockerCommand: options.dockerCommand,
      handoff,
      invocation,
      lifecycleRecovery: options.lifecycleRecovery,
      onDetachedReservation: options.onDetachedReservation,
      runRunner: options.runRunner ?? runDockerContainer,
      targetExecFile: options.targetExecFile,
    });
    const { organizationHandoffHandle, runMetadata } = executed;
    const existingRecordPath = invocation.detach && invocation.deploymentName
      ? resolveDeploymentRecordPath(buildResult.outputDirectory, invocation.deploymentName)
      : null;
    if (existingRecordPath && await fileExists(existingRecordPath)) {
      const existing = await readDeploymentRecord(existingRecordPath);
      const target = await resolveDockerDeploymentTarget({
        context: invocation.dockerContext ?? undefined,
        dockerCommand: invocation.command,
        dockerHost: invocation.dockerHost ?? undefined,
        execFile: options.targetExecFile,
      });
      const expected = createDockerDeploymentRecord({
        authProfileName: authProfile?.name ?? null,
        compileFingerprint: buildResult.report.compile_fingerprint ?? "",
        containerName: invocation.containerName,
        deploymentName: invocation.deploymentName ?? undefined,
        envFilePath: resolvedOptions.envFilePath,
        imageTag,
        networkIds: buildResult.report.container?.moltnet?.server_plans
          .filter((server) => server.mode === "managed").map((server) => server.network_id),
        nodes: buildResult.report.nodes,
        organizationHandoff: handoff.organizationHandoff,
        organizationHandoffHandle,
        outputDirectory: buildResult.outputDirectory,
        projectRoot: buildResult.report.root,
        runId: handoff.authority.runId,
        runMetadata,
        runtimeInstanceIds: buildResult.report.container?.runtime_instances.map((instance) => instance.id) ?? [],
        target,
      });
      if (canonicalJson(stableRecord(existing)) !== canonicalJson(stableRecord(expected))) {
        throw organizationHandoffInputError();
      }
      deploymentRecordPath = existingRecordPath;
    } else {
      deploymentRecordPath = invocation.detach && invocation.deploymentName
        ? await writeDockerDeploymentRecordForRun({
            authProfileName: authProfile?.name ?? null,
            envFilePath: resolvedOptions.envFilePath,
            imageTag,
            invocation,
            organizationHandoff: handoff.organizationHandoff,
            organizationHandoffHandle,
            outputDirectory: buildResult.outputDirectory,
            report: buildResult.report,
            runMetadata,
            targetExecFile: options.targetExecFile,
          })
        : null;
    }
  } else {
    let dockerLifecycleInvoked = false;
    try {
      if (options.onDetachedReservation) {
        if (!invocation.detach || !invocation.containerName || !invocation.deploymentLabels) {
          throw new SpawnfileError("runtime_error", "Detached deployment authority is incomplete");
        }
        await options.onDetachedReservation({
          containerName: invocation.containerName,
          deploymentLabels: invocation.deploymentLabels,
          dockerCommand: invocation.command,
          dockerContext: invocation.dockerContext ?? null,
        });
      }
      dockerLifecycleInvoked = true;
      const runMetadata = await executeDockerRunWithSupportCleanup(invocation, options.runRunner ?? runDockerContainer);
      deploymentRecordPath = invocation.detach && invocation.deploymentName
        ? await writeDockerDeploymentRecordForRun({
            authProfileName: authProfile?.name ?? null,
            envFilePath: resolvedOptions.envFilePath,
            imageTag,
            invocation,
            outputDirectory: buildResult.outputDirectory,
            report: buildResult.report,
            runMetadata: runMetadata ?? undefined,
            targetExecFile: options.targetExecFile,
          })
        : null;
    } finally {
      if (invocation.detach && !dockerLifecycleInvoked) {
        await rm(invocation.envFilePath, { force: true });
      }
    }
  }

  if (deploymentRecordPath && buildResult.organizationReadinessEvidence) {
    const record = await readDeploymentRecord(deploymentRecordPath);
    const pending = createOrganizationReadinessPending(buildResult.organizationReadinessEvidence, {
      compileFingerprint: record.compile_fingerprint,
      deploymentName: record.name,
      runId: record.run_id ?? null,
      unitCount: record.units.length,
      unitId: record.units[0]?.id ?? "invalid-unit"
    });
    const pendingRecord = { ...record, organization_ready: pending };
    await writeDeploymentRecord(buildResult.outputDirectory, pendingRecord);
    const organizationReady = await probeDockerOrganizationReadiness({
      dockerCommand: options.dockerCommand,
      evidence: buildResult.organizationReadinessEvidence,
      execFile: options.targetExecFile,
      record: pendingRecord
    });
    await writeDeploymentRecord(buildResult.outputDirectory, {
      ...pendingRecord,
      organization_ready: organizationReady
    });
  }

  return {
    ...buildResult,
    authProfileName: authProfile?.name ?? null,
    containerName: invocation.containerName,
    deploymentRecordPath,
    imageTag,
    supportDirectory: invocation.supportDirectory
  };
};
