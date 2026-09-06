import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { requireAuthProfile, type ResolvedAuthProfile } from "../auth/index.js";
import {
  ensureDirectory,
  fileExists,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
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
import { ensureNoopolisRunId, resolveNoopolisRunId } from "../runtime/index.js";

import {
  compileProject,
  type CompileProjectOptions,
  type CompileProjectResult
} from "./compileProject.js";
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
  assertDeclaredModelAuthSatisfied,
  assertMoltnetCredentialValuesDistinct,
  assertRunEnvironmentSatisfied,
  prepareRuntimeAuthMounts,
  readRunEnvFile,
  renderDockerEnvFile,
  resolveAuthMountArgs,
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
    /** See `RuntimeAuthPreparationInput.containerCredentialUid`. */
    containerCredentialUid?: number;
    containerName?: string;
    detach?: boolean;
    deploymentName?: string;
    dockerCommand?: string;
    dockerContext?: string;
    dockerHost?: string;
    envFilePath?: string;
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
    assertDeclaredModelAuthSatisfied(
      containerReport,
      options.authProfile ?? null,
      options.cliCredential !== undefined
    );
    const env = resolveRunEnvironment(
      containerReport,
      options.authProfile ?? null,
      {
        ...(await readRunEnvFile(options.envFilePath)),
        ...(options.cliCredential ? { [options.cliCredential.name]: options.cliCredential.value } : {})
      }
    );
    const preparedRuntimeAuth = await prepareRuntimeAuthMounts(
      compileResult.outputDirectory,
      containerReport,
      options.authProfile ?? null,
      env,
      supportDirectory,
      options.containerCredentialUid
    );
    assertRunEnvironmentSatisfied(containerReport, env, preparedRuntimeAuth.coveredModelSecrets);
    assertMoltnetCredentialValuesDistinct(containerReport, env);
    const hasDaimon = containerReport.runtime_instances.some(
      (instance) => instance.runtime === "daimon"
    );
    const opaqueDaimonCredentials = preparedRuntimeAuth.launchIdentity?.kind === "daimon";

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
      args.push("--rm");
    }

    args.push("--name", containerName);

    if (hasDaimon) {
      args.push(
        "--cap-drop=ALL",
        "--cap-add=CHOWN",
        "--cap-add=SETUID",
        "--cap-add=SETGID",
        "--cap-add=DAC_READ_SEARCH",
        // Lets the broker launcher drop its bounding set to 00000000000000c1; without SETPCAP, setpriv --bounding-set silently no-ops.
        "--cap-add=SETPCAP",
        // The entrypoint supervises children dropped to uid 2100/2200+; without CAP_KILL, root cannot even kill -0 them, so a live child reads as dead.
        "--cap-add=KILL",
        "--security-opt=no-new-privileges:true"
      );
    }

    for (const port of containerReport.ports) {
      args.push("-p", `${port}:${port}`);
    }

    // Compiler-owned persistent mounts are mounted WITHOUT `volume-nocopy`.
    // The image is the authority for the bootstrap preimage at these paths:
    // `createStateOwnershipCommand` writes a `.spawnfile-volume-init` marker
    // into every one of them at build time, and the Daimon ownership guard
    // (`secureVolumeIdentity`) and `prepare_volume_resource` both REQUIRE that
    // marker as the fresh-volume preimage. `volume-nocopy` is exactly the flag
    // that stops Docker copying image content into an empty volume, so it
    // starved the guard and no Daimon organization with persistent volumes
    // could bootstrap. Copy-up only ever populates an EMPTY volume, so a
    // reattached volume that already holds state is untouched by dropping it.
    // (Target/secrets volumes under src/target/* keep `volume-nocopy`: no
    // image content backs those paths and they must stay opaque.)
    for (const mount of containerReport.persistent_mounts ?? []) {
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
    args.push(...(await resolveAuthMountArgs(containerReport, options.authProfile ?? null)));
    args.push(...preparedRuntimeAuth.mountArgs);
    args.push(imageTag);

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
      ...((containerReport.persistent_mounts ?? []).some((mount) => mount.lifecycle === "exclusive-reattach") ? {
        exclusiveReattachVolumes: (containerReport.persistent_mounts ?? [])
          .filter((mount) => mount.lifecycle === "exclusive-reattach")
          .map((mount) => mount.volume_name)
          .sort()
      } : {}),
      imageTag,
      ...(opaqueDaimonCredentials ? { opaqueDaimonCredentials } : {}),
      supportDirectory
    };
  } catch (error) {
    await removeDirectory(supportDirectory);
    throw error;
  }
};

interface ResolvedRunDeploymentOptions {
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
