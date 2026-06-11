import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { DeploymentRecord } from "./record.js";
import { dockerContextNameForTarget, verifyDockerDeploymentTarget } from "./target.js";

const execFile = promisify(execFileCallback);

export type DockerInspectExecFile = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stderr: string; stdout: string }>;

export interface DockerUnitInspection {
  containerId: string | null;
  drift: string[];
  exists: boolean | null;
  exitCode: number | null;
  finishedAt: string | null;
  imageId: string | null;
  message: string;
  restartCount: number | null;
  running: boolean | null;
  severity: "error" | "ok" | "unknown" | "warn";
  startedAt: string | null;
  status: string | null;
  unitId: string;
}

export type DockerInspectionResult = Map<string, DockerUnitInspection>;

export interface DockerInspectOptions {
  dockerCommand?: string;
  execFile?: DockerInspectExecFile;
  timeoutMs?: number;
}

const toStringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const toNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const targetRefForUnit = (
  unit: DeploymentRecord["units"][number]
): string | null => unit.container_id ?? unit.container_name;

const argsForInspect = (record: DeploymentRecord, targetRef: string): string[] => {
  const context = dockerContextNameForTarget(record.target);
  if (context) {
    return ["--context", context, "inspect", targetRef];
  }
  if (record.target.kind === "host") {
    return ["--host", record.target.value, "inspect", targetRef];
  }

  return ["inspect", targetRef];
};

const matchesDockerId = (recorded: string | null, live: string | null): boolean =>
  !recorded
  || !live
  || recorded === live
  || live.startsWith(recorded)
  || recorded.startsWith(live);

const createDriftMessages = (
  unit: DeploymentRecord["units"][number],
  inspected: Record<string, unknown>
): { containerId: string | null; drift: string[]; imageId: string | null } => {
  const containerId = toStringOrNull(inspected.Id);
  const imageId = toStringOrNull(inspected.Image);
  const drift: string[] = [];
  if (!matchesDockerId(unit.container_id, containerId)) {
    drift.push(`container id drift: recorded ${unit.container_id}, live ${containerId}`);
  }
  if (!matchesDockerId(unit.image_id, imageId)) {
    drift.push(`image id drift: recorded ${unit.image_id}, live ${imageId}`);
  }

  return { containerId, drift, imageId };
};

const inspectionFromState = (
  unitId: string,
  unit: DeploymentRecord["units"][number],
  inspected: Record<string, unknown>,
  state: Record<string, unknown>
): DockerUnitInspection => {
  const running = typeof state.Running === "boolean" ? state.Running : null;
  const status = toStringOrNull(state.Status);
  const { containerId, drift, imageId } = createDriftMessages(unit, inspected);
  const baseMessage = running === true
    ? `container is running (${status ?? "running"})`
    : `container is not running (${status ?? "unknown"})`;
  return {
    containerId,
    drift,
    exists: true,
    exitCode: toNumberOrNull(state.ExitCode),
    finishedAt: toStringOrNull(state.FinishedAt),
    imageId,
    message: drift.length > 0 ? `${baseMessage}; ${drift.join("; ")}` : baseMessage,
    restartCount: toNumberOrNull(state.RestartCount),
    running,
    severity: drift.length > 0 ? "warn" : running === false ? "error" : "ok",
    startedAt: toStringOrNull(state.StartedAt),
    status,
    unitId
  };
};

const missingInspection = (
  unitId: string,
  message: string
): DockerUnitInspection => ({
  containerId: null,
  drift: [],
  exists: false,
  exitCode: null,
  finishedAt: null,
  imageId: null,
  message,
  restartCount: null,
  running: false,
  severity: "warn",
  startedAt: null,
  status: null,
  unitId
});

const unknownInspection = (
  unitId: string,
  message: string,
  severity: "error" | "unknown" = "unknown"
): DockerUnitInspection => ({
  containerId: null,
  drift: [],
  exists: null,
  exitCode: null,
  finishedAt: null,
  imageId: null,
  message,
  restartCount: null,
  running: null,
  severity,
  startedAt: null,
  status: null,
  unitId
});

const inspectUnit = async (
  record: DeploymentRecord,
  unit: DeploymentRecord["units"][number],
  options: Required<DockerInspectOptions>
): Promise<DockerUnitInspection> => {
  const targetRef = targetRefForUnit(unit);
  if (!targetRef) {
    return unknownInspection(unit.id, "deployment unit has no recorded container id or name");
  }

  try {
    const { stdout } = await options.execFile(
      options.dockerCommand,
      argsForInspect(record, targetRef),
      { timeout: options.timeoutMs }
    );
    const parsed = JSON.parse(stdout) as unknown;
    const [first] = Array.isArray(parsed) ? parsed : [];
    const state = isRecord(first) && isRecord(first.State) ? first.State : null;
    return state
      ? inspectionFromState(unit.id, unit, first, state)
      : unknownInspection(unit.id, `docker inspect returned no state for ${targetRef}`);
  } catch (error) {
    const stderr = isRecord(error) ? toStringOrNull(error.stderr) : null;
    const message = stderr ?? (error instanceof Error ? error.message : String(error));
    if (/No such object/i.test(message)) {
      return missingInspection(unit.id, `recorded container ${targetRef} is missing`);
    }
    return unknownInspection(unit.id, `unable to inspect container ${targetRef}: ${message}`, "error");
  }
};

export const inspectDockerDeployment = async (
  record: DeploymentRecord,
  options: DockerInspectOptions = {}
): Promise<DockerInspectionResult> => {
  const resolvedOptions: Required<DockerInspectOptions> = {
    dockerCommand: options.dockerCommand ?? "docker",
    execFile: options.execFile ?? execFile,
    timeoutMs: options.timeoutMs ?? 10_000
  };
  try {
    await verifyDockerDeploymentTarget(record.target, resolvedOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Map(record.units.map((unit) => [
      unit.id,
      unknownInspection(unit.id, `unable to verify recorded Docker target: ${message}`, "error")
    ]));
  }

  const inspections = await Promise.all(record.units.map(async (unit) => inspectUnit(
    record,
    unit,
    resolvedOptions
  )));
  return new Map(inspections.map((inspection) => [inspection.unitId, inspection]));
};
