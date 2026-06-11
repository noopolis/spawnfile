import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type {
  RuntimeProbeExecResult,
  RuntimeProbeGateway,
  RuntimeProbeHttpResult
} from "../runtime/index.js";

import type { DeploymentRecord } from "./record.js";
import type { DockerUnitInspection } from "./dockerInspect.js";
import { dockerContextNameForTarget } from "./target.js";

const execFile = promisify(execFileCallback);

export type DockerProbeExecFile = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stderr: string; stdout: string }>;

export interface DockerProbeGatewayOptions {
  dockerCommand?: string;
  execFile?: DockerProbeExecFile;
  inspection: DockerUnitInspection;
  timeoutMs?: number;
}

const targetRefForUnit = (
  unit: DeploymentRecord["units"][number]
): string => {
  const targetRef = unit.container_id ?? unit.container_name;
  if (!targetRef) {
    throw new Error(`deployment unit ${unit.id} has no recorded container id or name`);
  }
  return targetRef;
};

const withDockerTarget = (
  record: DeploymentRecord,
  args: string[]
): string[] => {
  const context = dockerContextNameForTarget(record.target);
  if (context) {
    return ["--context", context, ...args];
  }
  if (record.target.kind === "host") {
    return ["--host", record.target.value, ...args];
  }
  return args;
};

export const createDockerProbeGateway = (
  record: DeploymentRecord,
  unit: DeploymentRecord["units"][number],
  options: DockerProbeGatewayOptions
): RuntimeProbeGateway => {
  const dockerCommand = options.dockerCommand ?? "docker";
  const runExec = options.execFile ?? execFile;
  const timeout = options.timeoutMs ?? 10_000;

  const exec = async (command: string[]): Promise<RuntimeProbeExecResult> => {
    const targetRef = targetRefForUnit(unit);
    return runExec(
      dockerCommand,
      withDockerTarget(record, ["exec", targetRef, ...command]),
      { timeout }
    );
  };

  return {
    exec,
    async httpGet(
      port: number,
      requestPath: string,
      headers: Record<string, string> = {}
    ): Promise<RuntimeProbeHttpResult> {
      const url = `http://127.0.0.1:${port}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`;
      try {
        const headerArgs = Object.entries(headers).flatMap(([name, value]) => ["-H", `${name}: ${value}`]);
        const result = await exec(["curl", "-fsS", ...headerArgs, url]);
        return { body: result.stdout, ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { body: "", error: message, ok: false };
      }
    },
    async inspectUnit(): Promise<DockerUnitInspection> {
      return options.inspection;
    }
  };
};
