import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { SpawnfileError } from "../shared/index.js";

import { dockerDeploymentLabelKeys } from "./dockerLabels.js";
import type { DeploymentRecord } from "./record.js";
import {
  resolveDockerDeploymentTarget,
  type DockerTargetExecFile
} from "./target.js";

const execFile = promisify(execFileCallback);

export interface RecoverDockerDeploymentRecordsOptions {
  contains?: DeploymentRecord["units"][number]["contains"];
  context: string;
  dockerCommand?: string;
  execFile?: DockerTargetExecFile;
  outputDirectory: string;
  projectLabel: string;
  runtimeInstanceIds?: string[];
  sourceRoot: string;
  timeoutMs?: number;
}

interface DockerContainerInspection {
  Config?: {
    Image?: unknown;
    Labels?: unknown;
  };
  Created?: unknown;
  Id?: unknown;
  Image?: unknown;
  Name?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toStringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const labelsFrom = (inspection: DockerContainerInspection): Record<string, string> => {
  const labels = inspection.Config?.Labels;
  if (!isRecord(labels)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
};

const withContext = (context: string, args: string[]): string[] => [
  "--context",
  context,
  ...args
];

const containerNameFrom = (inspection: DockerContainerInspection): string | null => {
  const name = toStringOrNull(inspection.Name);
  return name ? name.replace(/^\//u, "") : null;
};

const parseInspections = (stdout: string): DockerContainerInspection[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new SpawnfileError(
      "runtime_error",
      `Unable to parse recovered Docker container inspection: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return Array.isArray(parsed) ? parsed.filter(isRecord) as DockerContainerInspection[] : [];
};

const deploymentNameFor = (labels: Record<string, string>): string | null =>
  labels[dockerDeploymentLabelKeys.deployment] ?? null;

const buildUnit = (
  inspection: DockerContainerInspection,
  labels: Record<string, string>,
  contains: DeploymentRecord["units"][number]["contains"],
  runtimeInstanceIds: string[]
): DeploymentRecord["units"][number] | null => {
  const unitId = labels[dockerDeploymentLabelKeys.unit];
  const imageTag = toStringOrNull(inspection.Config?.Image);
  if (!unitId || !imageTag) {
    return null;
  }
  return {
    container_id: toStringOrNull(inspection.Id),
    container_name: containerNameFrom(inspection),
    contains,
    id: unitId,
    image_id: toStringOrNull(inspection.Image),
    image_tag: imageTag,
    kind: "container",
    runtime_instances: runtimeInstanceIds
  };
};

const groupByDeployment = (
  inspections: DockerContainerInspection[],
  options: RecoverDockerDeploymentRecordsOptions,
  target: DeploymentRecord["target"]
): Array<{ path: string; record: DeploymentRecord }> => {
  const records = new Map<string, DeploymentRecord>();
  const unitsByDeployment = new Map<string, Set<string>>();
  const contains = options.contains ?? [];
  const runtimeInstanceIds = options.runtimeInstanceIds ?? [];

  for (const inspection of inspections) {
    const labels = labelsFrom(inspection);
    if (labels[dockerDeploymentLabelKeys.project] !== options.projectLabel) {
      continue;
    }
    const name = deploymentNameFor(labels);
    const compileFingerprint = labels[dockerDeploymentLabelKeys.compileFingerprint];
    if (!name || !compileFingerprint) {
      continue;
    }
    const unit = buildUnit(inspection, labels, contains, runtimeInstanceIds);
    if (!unit) {
      continue;
    }
    const seenUnits = unitsByDeployment.get(name) ?? new Set<string>();
    if (seenUnits.has(unit.id)) {
      throw new SpawnfileError(
        "validation_error",
        `Recovered deployment "${name}" has multiple containers for unit "${unit.id}"`
      );
    }
    seenUnits.add(unit.id);
    unitsByDeployment.set(name, seenUnits);

    const record = records.get(name) ?? {
      auth_profile: null,
      compile_fingerprint: compileFingerprint,
      created_at: toStringOrNull(inspection.Created) ?? new Date().toISOString(),
      manager: "docker",
      name,
      output_directory: options.outputDirectory,
      source: { kind: "project", root: options.sourceRoot },
      target,
      units: [],
      version: "spawnfile.deployment.v2"
    };
    record.units.push(unit);
    records.set(name, record);
  }

  return [...records.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((record) => ({
      path: `docker-context://${options.context}/${record.name}`,
      record: {
        ...record,
        units: [...record.units].sort((left, right) => left.id.localeCompare(right.id))
      }
    }));
};

export const recoverDockerDeploymentRecords = async (
  options: RecoverDockerDeploymentRecordsOptions
): Promise<Array<{ path: string; record: DeploymentRecord }>> => {
  const resolved = {
    dockerCommand: options.dockerCommand ?? "docker",
    execFile: options.execFile ?? execFile,
    timeoutMs: options.timeoutMs ?? 10_000
  };
  const target = await resolveDockerDeploymentTarget({
    context: options.context,
    dockerCommand: resolved.dockerCommand,
    execFile: resolved.execFile,
    timeoutMs: resolved.timeoutMs
  });
  const { stdout: listStdout } = await resolved.execFile(
    resolved.dockerCommand,
    withContext(options.context, [
      "ps",
      "-a",
      "--filter",
      `label=${dockerDeploymentLabelKeys.version}`,
      "--format",
      "{{.ID}}"
    ]),
    { timeout: resolved.timeoutMs }
  );
  const ids = listStdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (ids.length === 0) {
    return [];
  }

  const { stdout } = await resolved.execFile(
    resolved.dockerCommand,
    withContext(options.context, ["inspect", ...ids]),
    { timeout: resolved.timeoutMs }
  );
  return groupByDeployment(parseInspections(stdout), options, target);
};
