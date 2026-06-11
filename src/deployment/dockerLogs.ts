import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { DeploymentRecord } from "./record.js";
import { dockerContextNameForTarget } from "./target.js";

const execFile = promisify(execFileCallback);

export type DockerLogsExecFile = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stderr: string; stdout: string }>;

export interface DockerUnitLogs {
  containerRef: string | null;
  message: string;
  severity: "error" | "ok" | "unknown" | "warn";
  text: string;
  unitId: string;
}

export type DockerLogsResult = Map<string, DockerUnitLogs>;

export interface DockerLogsOptions {
  dockerCommand?: string;
  execFile?: DockerLogsExecFile;
  secretValues?: string[];
  tail?: number;
  timeoutMs?: number;
}

interface ResolvedDockerLogsOptions {
  dockerCommand: string;
  execFile: DockerLogsExecFile;
  secretValues: string[];
  tail: number;
  timeoutMs: number;
}

const targetRefForUnit = (
  unit: DeploymentRecord["units"][number]
): string | null => unit.container_id ?? unit.container_name;

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

const normalizeTail = (tail: number | undefined): number =>
  typeof tail === "number" && Number.isInteger(tail) && tail > 0 ? tail : 100;

const redactKnownSecrets = (text: string, secretValues: string[]): string =>
  secretValues
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), text);

const redactTokenLikeText = (text: string): string => {
  let redacted = text;
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/\bmagt_v1_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  redacted = redacted.replace(
    /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)([^\s"'`]+)/gi,
    "$1[REDACTED]"
  );
  redacted = redacted.replace(
    /("([^"]*(?:api[_-]?key|token|secret|password)[^"]*)"\s*:\s*")([^"]+)(")/gi,
    "$1[REDACTED]$4"
  );
  return redacted;
};

export const redactDockerLogText = (
  text: string,
  secretValues: string[] = []
): string => redactTokenLikeText(redactKnownSecrets(text, secretValues));

const combineLogStreams = (stdout: string, stderr: string): string => {
  if (!stdout) {
    return stderr;
  }
  if (!stderr) {
    return stdout;
  }
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
};

const missingUnitLogs = (unitId: string, message: string): DockerUnitLogs => ({
  containerRef: null,
  message,
  severity: "unknown",
  text: "",
  unitId
});

const failedUnitLogs = (
  unitId: string,
  containerRef: string,
  message: string,
  severity: "error" | "warn" = "error"
): DockerUnitLogs => ({
  containerRef,
  message,
  severity,
  text: "",
  unitId
});

const unitLogs = (
  unitId: string,
  containerRef: string,
  text: string
): DockerUnitLogs => ({
  containerRef,
  message: text.length > 0 ? "logs collected" : "logs collected; no output",
  severity: "ok",
  text,
  unitId
});

const toErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.length > 0) {
      return stderr.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
};

const readUnitLogs = async (
  record: DeploymentRecord,
  unit: DeploymentRecord["units"][number],
  options: ResolvedDockerLogsOptions
): Promise<DockerUnitLogs> => {
  const containerRef = targetRefForUnit(unit);
  if (!containerRef) {
    return missingUnitLogs(unit.id, "deployment unit has no recorded container id or name");
  }

  try {
    const result = await options.execFile(
      options.dockerCommand,
      withDockerTarget(record, ["logs", "--tail", String(options.tail), containerRef]),
      { timeout: options.timeoutMs }
    );
    return unitLogs(
      unit.id,
      containerRef,
      redactDockerLogText(combineLogStreams(result.stdout, result.stderr), options.secretValues)
    );
  } catch (error) {
    const message = redactDockerLogText(toErrorMessage(error), options.secretValues);
    if (/No such (?:object|container)/i.test(message)) {
      return failedUnitLogs(unit.id, containerRef, `recorded container ${containerRef} is missing`, "warn");
    }
    return failedUnitLogs(unit.id, containerRef, `unable to collect logs for ${containerRef}: ${message}`);
  }
};

export const readDockerDeploymentLogs = async (
  record: DeploymentRecord,
  options: DockerLogsOptions = {}
): Promise<DockerLogsResult> => {
  const resolvedOptions = {
    dockerCommand: options.dockerCommand ?? "docker",
    execFile: options.execFile ?? execFile,
    secretValues: options.secretValues ?? [],
    tail: normalizeTail(options.tail),
    timeoutMs: options.timeoutMs ?? 10_000
  };
  const results = await Promise.all(record.units.map(async (unit) => readUnitLogs(
    record,
    unit,
    resolvedOptions
  )));
  return new Map(results.map((result) => [result.unitId, result]));
};
