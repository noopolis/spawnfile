import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  compileProject,
  normalizeDockerArchitecture,
  type CompileProjectResult
} from "../compiler/index.js";
import {
  dockerContextNameForTarget,
  dockerHostValueForTarget,
  type DeploymentRecord
} from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";

export type DevExecFile = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stderr: string; stdout: string }>;

export const defaultExecFile = promisify(execFileCallback) as DevExecFile;

export const dockerArgsForRecord = (record: DeploymentRecord): string[] => {
  const context = dockerContextNameForTarget(record.target);
  if (context) {
    return ["--context", context];
  }
  const host = dockerHostValueForTarget(record.target);
  return host ? ["--host", host] : [];
};

export const firstContainerName = (record: DeploymentRecord): string => {
  const unit = record.units.find((candidate) => candidate.kind === "container") ?? record.units[0];
  const name = unit?.container_name;
  if (!name) {
    throw new SpawnfileError(
      "runtime_error",
      `Deployment "${record.name}" has no recorded container name`
    );
  }
  return name;
};

export const compileForDevApply = async (
  inputPath: string,
  outputDirectory: string,
  record: DeploymentRecord,
  dockerCommand: string,
  execFileImpl: DevExecFile
): Promise<CompileProjectResult> => {
  const dockerContext = dockerContextNameForTarget(record.target) ?? undefined;
  const architecture = dockerContext
    ? normalizeDockerArchitecture((await execFileImpl(
        dockerCommand,
        ["--context", dockerContext, "info", "--format", "{{.Architecture}}"],
        { timeout: 10_000 }
      )).stdout)
    : undefined;
  return compileProject(inputPath, {
    clean: false,
    containerArchitecture: architecture,
    outputDirectory
  });
};

export const runDocker = async (
  command: string,
  args: string[],
  execFileImpl: DevExecFile,
  timeout = 30_000
): Promise<string> => {
  const { stdout } = await execFileImpl(command, args, { timeout });
  return stdout;
};

export const copyIntoContainer = async (
  dockerCommand: string,
  dockerPrefix: string[],
  source: string,
  destination: string,
  execFileImpl: DevExecFile
): Promise<void> => {
  await runDocker(dockerCommand, [...dockerPrefix, "cp", source, destination], execFileImpl, 60_000);
};

export const ensureContainerDirectories = async (
  dockerCommand: string,
  dockerPrefix: string[],
  containerName: string,
  paths: string[],
  execFileImpl: DevExecFile
): Promise<void> => {
  if (paths.length === 0) {
    return;
  }
  await runDocker(
    dockerCommand,
    [
      ...dockerPrefix,
      "exec",
      "--user",
      "root",
      containerName,
      "mkdir",
      "-p",
      ...paths
    ],
    execFileImpl
  );
};

export const chownContainerPaths = async (
  dockerCommand: string,
  dockerPrefix: string[],
  containerName: string,
  paths: string[],
  execFileImpl: DevExecFile
): Promise<void> => {
  if (paths.length === 0) {
    return;
  }
  await runDocker(
    dockerCommand,
    [
      ...dockerPrefix,
      "exec",
      "--user",
      "root",
      containerName,
      "chown",
      "-R",
      "spawnfile:spawnfile",
      ...paths
    ],
    execFileImpl
  );
};
