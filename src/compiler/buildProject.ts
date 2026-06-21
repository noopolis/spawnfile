import path from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

import {
  compileProject,
  type CompileProjectOptions,
  type CompileProjectResult
} from "./compileProject.js";
import { slugify } from "./helpers.js";
import type { MoltnetTargetArchitecture } from "./moltnetBinaries.js";

const execFile = promisify(execFileCallback);

export interface DockerBuildInvocation {
  args: string[];
  command: string;
  cwd: string;
  dockerContext?: string | null;
  imageTag: string;
}

export type DockerBuildRunner = (invocation: DockerBuildInvocation) => Promise<void>;

export interface BuildProjectOptions extends CompileProjectOptions {
  buildRunner?: DockerBuildRunner;
  dockerCommand?: string;
  dockerContext?: string;
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
  options: string | { dockerCommand?: string; dockerContext?: string } = "docker"
): DockerBuildInvocation => ({
  args: typeof options === "string" || !options.dockerContext
    ? ["build", "-t", imageTag, "."]
    : ["--context", options.dockerContext, "build", "-t", imageTag, "."],
  command: typeof options === "string" ? options : options.dockerCommand ?? "docker",
  cwd: outputDirectory,
  dockerContext: typeof options === "string" ? null : options.dockerContext ?? null,
  imageTag
});

export const normalizeDockerArchitecture = (architecture: string): MoltnetTargetArchitecture => {
  switch (architecture.trim()) {
    case "amd64":
    case "x64":
    case "x86_64":
      return "amd64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      throw new SpawnfileError(
        "compile_error",
        `Docker target architecture ${architecture.trim() || "unknown"} is not supported by staged Moltnet binaries`
      );
  }
};

export const resolveDockerBuildArchitecture = async (
  options: Pick<BuildProjectOptions, "dockerCommand" | "dockerContext">
): Promise<MoltnetTargetArchitecture | undefined> => {
  if (!options.dockerContext) {
    return undefined;
  }

  try {
    const { stdout } = await execFile(
      options.dockerCommand ?? "docker",
      ["--context", options.dockerContext, "info", "--format", "{{.Architecture}}"],
      { timeout: 10_000 }
    );
    return normalizeDockerArchitecture(stdout);
  } catch (error) {
    if (error instanceof SpawnfileError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "compile_error",
      `Unable to resolve Docker context ${options.dockerContext} architecture: ${reason}`
    );
  }
};

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
  const targetArchitecture =
    options.containerArchitecture ?? await resolveDockerBuildArchitecture(options);
  const compileResult = await compileProject(inputPath, {
    clean: options.clean,
    containerArchitecture: targetArchitecture,
    outputDirectory: options.outputDirectory
  });
  const imageTag = options.imageTag ?? createDefaultImageTag(resolveImageTagRoot(inputPath));
  const invocation = createDockerBuildInvocation(
    compileResult.outputDirectory,
    imageTag,
    {
      dockerCommand: options.dockerCommand,
      dockerContext: options.dockerContext
    }
  );

  await (options.buildRunner ?? runDockerBuild)(invocation);

  return {
    ...compileResult,
    imageTag
  };
};
