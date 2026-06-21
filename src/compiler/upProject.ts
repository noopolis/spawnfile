import path from "node:path";

import { removeDirectory } from "../filesystem/index.js";
import { type DockerTargetExecFile, writeDockerDeploymentRecordForRun } from "../deployment/index.js";

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
import { requireAuthProfile } from "../auth/index.js";
import { CompileProjectOptions } from "./compileProject.js";
import { DEFAULT_OUTPUT_DIRECTORY } from "../shared/index.js";

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
  runRunner?: DockerRunRunner;
  targetExecFile?: DockerTargetExecFile;
}

export interface UpProjectResult extends BuildProjectResult {
  authProfileName: string | null;
  containerName: string | null;
  deploymentRecordPath?: string | null;
  supportDirectory: string | null;
}

export const upProject = async (
  inputPath: string,
  options: UpProjectOptions = {}
): Promise<UpProjectResult> => {
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
  const buildResult = await buildProject(inputPath, {
    buildRunner: options.buildRunner,
    clean: options.clean,
    dockerContext: resolvedOptions.dockerContext,
    dockerCommand: options.dockerCommand,
    imageTag: resolvedOptions.imageTag,
    outputDirectory: options.outputDirectory
  });
  const authProfile = resolvedOptions.authProfile
    ? await requireAuthProfile(resolvedOptions.authProfile)
    : null;
  const imageTag = resolvedOptions.imageTag ?? buildResult.imageTag;
  const invocation = await createDockerRunInvocation(buildResult, imageTag, {
    authProfile,
    containerName: resolvedOptions.containerName,
    detach: options.detach,
    deploymentName: resolvedOptions.deploymentName,
    dockerCommand: options.dockerCommand,
    dockerContext: resolvedOptions.dockerContext,
    dockerHost: resolvedOptions.dockerHost,
    envFilePath: resolvedOptions.envFilePath
  });

  let runMetadata: DockerRunResult | void;
  try {
    runMetadata = await (options.runRunner ?? runDockerContainer)(invocation);
  } finally {
    if (!invocation.detach) {
      await removeDirectory(invocation.supportDirectory);
    }
  }

  const deploymentRecordPath = invocation.detach && invocation.deploymentName
    ? await writeDockerDeploymentRecordForRun({
        authProfileName: authProfile?.name ?? null,
        envFilePath: resolvedOptions.envFilePath,
        imageTag,
        invocation,
        outputDirectory: buildResult.outputDirectory,
        report: buildResult.report,
        runMetadata: runMetadata ?? undefined,
        targetExecFile: options.targetExecFile
      })
    : null;

  return {
    ...buildResult,
    authProfileName: authProfile?.name ?? null,
    containerName: invocation.containerName,
    deploymentRecordPath,
    imageTag,
    supportDirectory: invocation.supportDirectory
  };
};
