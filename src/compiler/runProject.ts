import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { requireAuthProfile, type ResolvedAuthProfile } from "../auth/index.js";
import { ensureDirectory, fileExists, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import type { ContainerReport } from "../report/index.js";
import {
  appendDockerLabelArgs,
  createDockerDeploymentLabels,
  createDockerDeploymentUnitId,
  createDockerProjectLabel,
  dockerContextNameForTarget,
  dockerHostValueForTarget,
  normalizeDeploymentName,
  readDeploymentRecordFromOutput,
  resolveDeploymentRecordPath,
  type DeploymentRecord,
  type DockerTargetExecFile,
  verifyDockerDeploymentTarget,
  writeDockerDeploymentRecordForRun
} from "../deployment/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, SpawnfileError } from "../shared/index.js";
import { ensureNoopolisRunId, isBundledRuntimeAdapter, listRuntimeAdapters, resolveNoopolisRunId } from "../runtime/index.js";
import { runtimeHost, selectedRuntimeHosts } from "../runtime/hostSelection.js";

import { compileProject, type CompileProjectOptions, type CompileProjectResult } from "./compileProject.js";
import { createDefaultImageTag, resolveDockerBuildArchitecture } from "./buildProject.js";
import { slugify } from "./helpers.js";
import {
  inspectDetachedContainer as recoverDetachedDockerRun,
  runDockerContainer,
  type DockerRunInvocation,
  type DockerRunResult,
  type DockerRunRunner
} from "./runProjectDocker.js";
import { executeDockerRunWithSupportCleanup } from "./runProjectLifecycle.js";
import {
  assertMoltnetCredentialValuesDistinct,
  assertRunEnvironmentSatisfied,
  prepareRunHomeAuth,
  prepareRuntimeAuthMounts,
  readRunEnvFile,
  renderDockerEnvFile,
  resolveRunEnvironment
} from "./runProjectAuth.js";

export { recoverDetachedDockerRun, runDockerContainer };
export type { DockerRunInvocation, DockerRunResult, DockerRunRunner };

export interface RunProjectOptions extends CompileProjectOptions {
  authProfile?: string;
  containerName?: string;
  detach?: boolean;
  deploymentName?: string;
  dockerCommand?: string;
  dockerContext?: string;
  dockerHost?: string;
  envFilePath?: string;
  imageTag?: string;
  runRunner?: DockerRunRunner;
  targetExecFile?: DockerTargetExecFile;
}

export interface RunProjectResult extends CompileProjectResult {
  authProfileName: string | null;
  containerName: string | null;
  deploymentRecordPath?: string | null;
  imageTag: string;
}
const resolveImageTagRoot = (inputPath: string): string => {
  const resolvedPath = path.resolve(inputPath);
  return path.basename(resolvedPath).toLowerCase() === "spawnfile"
    ? path.dirname(resolvedPath)
    : resolvedPath;
};

const createDefaultContainerName = (imageTag: string): string => {
  const containerName = slugify(imageTag.replaceAll("/", "-").replaceAll(":", "-"));
  return containerName || "spawnfile-run";
};

export const createDockerRunInvocation = async (
  compileResult: CompileProjectResult,
  imageTag: string,
  options: {
    authProfile?: ResolvedAuthProfile | null;
    cliCredential?: { name: string; value: string };
    command?: readonly string[]; // after the image: its own one-shot command (`auth agy login --config <path>`)
    /** See `RuntimeAuthPreparationInput.containerCredentialUid`. */
    containerCredentialUid?: number;
    containerName?: string;
    detach?: boolean;
    deploymentName?: string;
    dockerCommand?: string;
    dockerContext?: string;
    dockerHost?: string;
    envFilePath?: string;
    interactive?: boolean; // attach the operator's terminal (`-it`) to a foreground run
    network?: string; // a user-defined network to join (a training run's private gateway network)
  } = {}
): Promise<DockerRunInvocation> => {
  const containerReport = compileResult.report.container;
  if (!containerReport) {
    throw new SpawnfileError(
      "runtime_error",
      "Compile output did not include container metadata"
    );
  }

  const supportDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-run-"));
  const envFilePath = path.join(supportDirectory, "run.env");

  try {
    const env = resolveRunEnvironment(
      containerReport,
      options.authProfile ?? null,
      {
        ...(await readRunEnvFile(options.envFilePath)),
        ...(options.cliCredential ? { [options.cliCredential.name]: options.cliCredential.value } : {})
      }
    );
    const importedAuth = await prepareRunHomeAuth(containerReport, options.authProfile ?? null, env);
    const preparedRuntimeAuth = await prepareRuntimeAuthMounts(
      compileResult.outputDirectory,
      containerReport,
      options.authProfile ?? null,
      env,
      supportDirectory,
      options.containerCredentialUid
    );
    assertRunEnvironmentSatisfied(containerReport, env, new Set([...importedAuth.coveredModelSecrets, ...preparedRuntimeAuth.coveredModelSecrets]));
    assertMoltnetCredentialValuesDistinct(containerReport, env);
    const hosts = selectedRuntimeHosts(containerReport.runtime_instances.map((instance) => instance.runtime));
    const credentialHost = preparedRuntimeAuth.credentialRuntime
      ? runtimeHost(preparedRuntimeAuth.credentialRuntime)
      : undefined;
    const prepareCredentialDocker = credentialHost?.prepareCredentialDocker?.bind(credentialHost);
    if (preparedRuntimeAuth.launchIdentity && !prepareCredentialDocker) {
      throw new SpawnfileError("validation_error", "Runtime credential launch is missing a Docker endpoint guard");
    }

    await ensureDirectory(supportDirectory);
    await writeUtf8File(envFilePath, renderDockerEnvFile(env));

    const deploymentName = options.deploymentName
      ? normalizeDeploymentName(options.deploymentName)
      : options.detach
        ? normalizeDeploymentName(undefined)
        : null;
    const containerName = options.containerName ?? createDefaultContainerName(imageTag);
    const args = options.dockerContext
      ? ["--context", options.dockerContext, "run"]
      : options.dockerHost
        ? ["--host", options.dockerHost, "run"]
        : ["run"];

    if (options.detach) {
      args.push("-d", "--restart", "unless-stopped");
    } else {
      args.push("--rm", ...(options.interactive ? ["-it"] : []));
    }

    args.push("--name", containerName);
    if (options.network) args.push("--network", options.network);

    for (const { host } of hosts) {
      if (host.projectSecurityArgs) args.push(...await host.projectSecurityArgs(compileResult));
    }

    for (const port of containerReport.ports) {
      args.push("-p", `${port}:${port}`);
    }

    // Compiler-owned persistent mounts are mounted WITHOUT `volume-nocopy`.
    // The image is the authority for the bootstrap preimage at these paths:
    // `createStateOwnershipCommand` writes a `.spawnfile-volume-init` marker
    // at build time. Native ownership guards and `prepare_volume_resource`
    // both require that marker on first use. Docker copy-up populates empty
    // volumes, leaving reattached state intact.
    // (Target/secrets volumes under src/target/* keep `volume-nocopy`: no
    // image content backs those paths and they must stay opaque.)
    // Older reports can identify a credential realm only by its declared mount.
    const installed = containerReport.runtimes_installed;
    const mountHosts = containerReport.runtime_instances.length ? hosts : selectedRuntimeHosts(
      installed?.length ? installed : listRuntimeAdapters().filter(isBundledRuntimeAdapter)
    );
    const persistentMounts = (containerReport.persistent_mounts ?? []).flatMap((mount) => {
      for (const { host } of mountHosts) {
        const externalEnv = host.externalMountEnvironment?.(mount.id);
        if (externalEnv && env[externalEnv]) return [];
        const volumeName = host.profileVolumeName?.(mount.id, options.authProfile ?? null);
        if (volumeName) return [{ ...mount, volume_name: volumeName }];
      }
      return [mount];
    });
    for (const mount of persistentMounts) {
      args.push(
        "--mount",
        `type=volume,source=${mount.volume_name},target=${mount.mount_path}`
      );
    }

    const deploymentLabels = options.detach && deploymentName ? (() => {
      const compileFingerprint = compileResult.report.compile_fingerprint ?? "sf1:unknown";
      const runId = resolveNoopolisRunId(process.env);
      if (!runId) throw new SpawnfileError("runtime_error", "Detached deployment requires a run id for deployment labels");
      return createDockerDeploymentLabels({ compileFingerprint, deployment: deploymentName,
        project: createDockerProjectLabel(compileResult.report.root, compileResult.report.project_name),
        runId, unit: createDockerDeploymentUnitId(deploymentName), version: compileResult.report.spawnfile_version });
    })() : undefined;
    if (deploymentLabels) appendDockerLabelArgs(args, deploymentLabels);

    args.push("--env-file", envFilePath);
    args.push(...importedAuth.mountArgs);
    args.push(...preparedRuntimeAuth.mountArgs);
    args.push(imageTag, ...(options.command ?? []));

    return {
      args,
      command: options.dockerCommand ?? "docker",
      containerName,
      cwd: compileResult.outputDirectory,
      detach: options.detach ?? false,
      deploymentName,
      ...(deploymentLabels ? { deploymentLabels } : {}),
      dockerContext: options.dockerContext ?? null,
      dockerHost: options.dockerHost ?? null,
      envFilePath,
      ...(persistentMounts.some((mount) => mount.lifecycle === "exclusive-reattach") ? {
        exclusiveReattachVolumes: persistentMounts
          .filter((mount) => mount.lifecycle === "exclusive-reattach")
          .map((mount) => mount.volume_name)
          .sort()
      } : {}),
      imageTag,
      ...(prepareCredentialDocker ? { prepareCredentialDocker } : {}),
      supportDirectory
    };
  } catch (error) {
    await removeDirectory(supportDirectory);
    throw error;
  }
};

interface ResolvedRunDeploymentOptions {
  previousRecord?: DeploymentRecord;
  authProfile?: string;
  containerName?: string;
  deploymentName?: string;
  dockerCommand?: string;
  dockerContext?: string;
  dockerHost?: string;
  envFilePath?: string;
  imageTag?: string;
  targetExecFile?: DockerTargetExecFile;
}

const readExistingDeploymentRecord = async (
  outputDirectory: string,
  deploymentName: string
): Promise<DeploymentRecord | null> => {
  const recordPath = resolveDeploymentRecordPath(outputDirectory, deploymentName);
  if (!await fileExists(recordPath)) {
    return null;
  }
  return readDeploymentRecordFromOutput(outputDirectory, deploymentName);
};

const firstDeploymentUnit = (
  record: DeploymentRecord
): DeploymentRecord["units"][number] | null =>
  record.units[0] ?? null;

export const resolveDetachedDeploymentOptions = async (
  outputDirectory: string,
  options: ResolvedRunDeploymentOptions & { detach?: boolean }
): Promise<ResolvedRunDeploymentOptions> => {
  if (!options.detach) {
    return options;
  }

  const deploymentName = normalizeDeploymentName(options.deploymentName);
  const record = await readExistingDeploymentRecord(outputDirectory, deploymentName);
  if (!record) {
    return {
      ...options,
      deploymentName
    };
  }

  const unit = firstDeploymentUnit(record);
  if (!options.dockerContext && !options.dockerHost) {
    await verifyDockerDeploymentTarget(record.target, {
      dockerCommand: options.dockerCommand,
      execFile: options.targetExecFile
    });
  }

  return {
    previousRecord: record,
    authProfile: options.authProfile ?? record.auth_profile ?? undefined,
    containerName: options.containerName ?? unit?.container_name ?? undefined,
    deploymentName,
    dockerContext: options.dockerContext ?? dockerContextNameForTarget(record.target) ?? undefined,
    dockerHost: options.dockerHost ?? dockerHostValueForTarget(record.target) ?? undefined,
    envFilePath: options.envFilePath ?? record.env_file,
    imageTag: options.imageTag ?? unit?.image_tag
  };
};

export const runProject = async (
  inputPath: string,
  options: RunProjectOptions = {}
): Promise<RunProjectResult> => {
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
  const targetArchitecture =
    options.containerArchitecture ??
    await resolveDockerBuildArchitecture({
      dockerCommand: options.dockerCommand,
      dockerContext: resolvedOptions.dockerContext
    });
  // Every authority container compiled for this run must stamp causal
  // events under the same real run id (see specs/CAUSAL.md). compileProject
  // itself stays a deterministic function of the host env; this only fills
  // in a generated id when the host did not already provide one, before the
  // compile step that bakes it into the entrypoint/recipe env.
  ensureNoopolisRunId();
  const compileResult = await compileProject(inputPath, {
    clean: options.clean,
    containerArchitecture: targetArchitecture,
    deploymentLineage: resolvedOptions.deploymentName ?? "ephemeral",
    outputDirectory: options.outputDirectory,
    ...(options.worldBindingsPath !== undefined
      ? { worldBindingsPath: options.worldBindingsPath }
      : {})
  });
  const imageTag = resolvedOptions.imageTag ?? createDefaultImageTag(resolveImageTagRoot(inputPath));
  const authProfile = resolvedOptions.authProfile
    ? await requireAuthProfile(resolvedOptions.authProfile)
    : null;
  const invocation = await createDockerRunInvocation(compileResult, imageTag, {
    authProfile,
    containerName: resolvedOptions.containerName,
    detach: options.detach,
    deploymentName: resolvedOptions.deploymentName,
    dockerCommand: options.dockerCommand,
    dockerContext: resolvedOptions.dockerContext,
    dockerHost: resolvedOptions.dockerHost,
    envFilePath: resolvedOptions.envFilePath
  });

  const runMetadata: DockerRunResult | void =
    await executeDockerRunWithSupportCleanup(
      invocation,
      options.runRunner ?? runDockerContainer
    );

  const deploymentRecordPath = invocation.detach && invocation.deploymentName
    ? await writeDockerDeploymentRecordForRun({
        previousRecord: resolvedOptions.previousRecord,
        authProfileName: authProfile?.name ?? null,
        envFilePath: resolvedOptions.envFilePath,
        imageTag,
        invocation,
        outputDirectory: compileResult.outputDirectory,
        report: compileResult.report,
        runMetadata: runMetadata ?? undefined,
        targetExecFile: options.targetExecFile
      })
    : null;

  return {
    ...compileResult,
    authProfileName: authProfile?.name ?? null,
    containerName: invocation.containerName,
    deploymentRecordPath,
    imageTag
  };
};
