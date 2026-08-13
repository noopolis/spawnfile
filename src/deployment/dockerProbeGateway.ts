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

const imageRefForUnit = (unit: DeploymentRecord["units"][number]): string =>
  unit.image_id
    ? (/^[a-f0-9]{64}$/u.test(unit.image_id) ? `sha256:${unit.image_id}` : unit.image_id)
    : unit.image_tag;

const redactProbeText = (value: string, limit: number): string => value
  .replace(/\s+/gu, " ")
  .replace(/(bearer|token|password|passwd|secret|authorization)[=: ]+(?:bearer[ ]+)?[^ ]+/giu, "$1=[redacted]")
  .replace(/https?:\/\/[^ ]+/giu, "[url redacted]")
  .slice(0, limit);

const boundedProbeFailure = (error: unknown): string => {
  if (!error || typeof error !== "object") return redactProbeText(String(error), 240) || "probe failed";
  const candidate = error as { code?: unknown; status?: unknown; stderr?: unknown; message?: unknown };
  const hasStatus = typeof candidate.status === "number" || typeof candidate.status === "string";
  const hasCode = typeof candidate.code === "number" || typeof candidate.code === "string";
  const status = hasStatus
    ? `status ${String(candidate.status)}`
    : hasCode
      ? `exit ${String(candidate.code)}`
      : "failed";
  const stderr = typeof candidate.stderr === "string"
    ? redactProbeText(candidate.stderr, 240)
    : "";
  const message = typeof candidate.message === "string" ? redactProbeText(candidate.message, 160) : "";
  if (error instanceof Error && !stderr) return message || "probe failed";
  if (stderr) return `docker probe ${status}: ${stderr}`;
  if (message) return hasStatus || hasCode ? `docker probe ${status}: ${message}` : message;
  return `docker probe ${status}`;
};

const parseCurlHttpOutput = (stdout: string): RuntimeProbeHttpResult => {
  const match = /\n(\d{3})$/u.exec(stdout);
  if (!match || match.index === undefined) {
    return { body: "", error: "malformed HTTP probe response", ok: false };
  }
  const status = Number(match[1]);
  const body = stdout.slice(0, match.index);
  return status >= 200 && status <= 299
    ? { body, ok: true }
    : { body, error: `HTTP ${status}`, ok: false };
};

const httpProbeArgs = (
  targetRef: string,
  imageRef: string,
  url: string
): string[] => [
  "run",
  "--rm",
  "--network",
  `container:${targetRef}`,
  "--entrypoint",
  "curl",
  imageRef,
  "-sS",
  "--output",
  "-",
  "--write-out",
  "\\n%{http_code}",
  url
];

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
      if (Object.keys(headers).length > 0) {
        return { body: "", error: "HTTP probe headers are forbidden", ok: false };
      }
      const url = `http://127.0.0.1:${port}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`;
      try {
        const targetRef = targetRefForUnit(unit);
        const result = await runExec(
          dockerCommand,
          withDockerTarget(record, httpProbeArgs(targetRef, imageRefForUnit(unit), url)),
          { timeout }
        );
        return parseCurlHttpOutput(result.stdout);
      } catch (error) {
        return { body: "", error: boundedProbeFailure(error), ok: false };
      }
    },
    async inspectUnit(): Promise<DockerUnitInspection> {
      return options.inspection;
    }
  };
};
