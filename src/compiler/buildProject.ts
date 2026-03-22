import path from "node:path";
import { spawn } from "node:child_process";

import { SpawnfileError } from "../shared/index.js";

import {
  compileProject,
  type CompileProjectOptions,
  type CompileProjectResult
} from "./compileProject.js";
import { slugify } from "./helpers.js";

export interface DockerBuildInvocation {
  args: string[];
  command: string;
  cwd: string;
  imageTag: string;
}

export type DockerBuildRunner = (invocation: DockerBuildInvocation) => Promise<void>;

export interface BuildProjectOptions extends CompileProjectOptions {
  buildRunner?: DockerBuildRunner;
  dockerCommand?: string;
  imageTag?: string;
}

export interface BuildProjectResult extends CompileProjectResult {
  imageTag: string;
}

export const createDefaultImageTag = (projectRoot: string): string => {
  const baseName = slugify(path.basename(projectRoot));
  return `spawnfile-${baseName || "project"}`;
};

const resolveImageTagRoot = (inputPath: string): string => {
  const resolvedPath = path.resolve(inputPath);
  return path.basename(resolvedPath).toLowerCase() === "spawnfile"
    ? path.dirname(resolvedPath)
    : resolvedPath;
};

export const createDockerBuildInvocation = (
  outputDirectory: string,
  imageTag: string,
  dockerCommand = "docker"
): DockerBuildInvocation => ({
  args: ["build", "-t", imageTag, "."],
  command: dockerCommand,
  cwd: outputDirectory,
  imageTag
});

export const runDockerBuild: DockerBuildRunner = async (
  invocation: DockerBuildInvocation
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      reject(
        new SpawnfileError(
          "compile_error",
          `Unable to start docker build for ${invocation.imageTag}: ${error.message}`
        )
      );
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new SpawnfileError(
          "compile_error",
          signal
            ? `Docker build for ${invocation.imageTag} exited from signal ${signal}`
            : `Docker build for ${invocation.imageTag} failed with exit code ${code ?? "unknown"}`
        )
      );
    });
  });

export const buildProject = async (
  inputPath: string,
  options: BuildProjectOptions = {}
): Promise<BuildProjectResult> => {
  const compileResult = await compileProject(inputPath, {
    clean: options.clean,
    outputDirectory: options.outputDirectory
  });
  const imageTag = options.imageTag ?? createDefaultImageTag(resolveImageTagRoot(inputPath));
  const invocation = createDockerBuildInvocation(
    compileResult.outputDirectory,
    imageTag,
    options.dockerCommand
  );

  await (options.buildRunner ?? runDockerBuild)(invocation);

  return {
    ...compileResult,
    imageTag
  };
};
