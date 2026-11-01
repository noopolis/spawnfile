import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

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

export const runDocker = async (
  command: string,
  args: string[],
  execFileImpl: DevExecFile,
  timeout = 30_000
): Promise<string> => {
  const { stdout } = await execFileImpl(command, args, { timeout });
  return stdout;
};
