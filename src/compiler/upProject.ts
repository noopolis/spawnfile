import { removeDirectory } from "../filesystem/index.js";

import {
  buildProject,
  type BuildProjectResult,
  type DockerBuildRunner
} from "./buildProject.js";
import { createDockerRunInvocation, runDockerContainer, type DockerRunRunner } from "./runProject.js";
import { requireAuthProfile } from "../auth/index.js";
import { CompileProjectOptions } from "./compileProject.js";

export interface UpProjectOptions extends CompileProjectOptions {
  authProfile?: string;
  buildRunner?: DockerBuildRunner;
  containerName?: string;
  detach?: boolean;
  dockerCommand?: string;
  envFilePath?: string;
  imageTag?: string;
  runRunner?: DockerRunRunner;
}

export interface UpProjectResult extends BuildProjectResult {
  authProfileName: string | null;
  containerName: string | null;
}

export const upProject = async (
  inputPath: string,
  options: UpProjectOptions = {}
): Promise<UpProjectResult> => {
  const buildResult = await buildProject(inputPath, {
    buildRunner: options.buildRunner,
    clean: options.clean,
    dockerCommand: options.dockerCommand,
    imageTag: options.imageTag,
    outputDirectory: options.outputDirectory
  });
  const authProfile = options.authProfile
    ? await requireAuthProfile(options.authProfile)
    : null;
  const invocation = await createDockerRunInvocation(buildResult, buildResult.imageTag, {
    authProfile,
    containerName: options.containerName,
    detach: options.detach,
    dockerCommand: options.dockerCommand,
    envFilePath: options.envFilePath
  });

  try {
    await (options.runRunner ?? runDockerContainer)(invocation);
  } finally {
    if (!invocation.detach) {
      await removeDirectory(invocation.supportDirectory);
    }
  }

  return {
    ...buildResult,
    authProfileName: authProfile?.name ?? null,
    containerName: invocation.containerName
  };
};
