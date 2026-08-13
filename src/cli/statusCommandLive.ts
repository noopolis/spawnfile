import path from "node:path";

import type { OrganizationView } from "../compiler/index.js";
import {
  inspectDockerDeployment,
  listDeploymentRecords,
  listHomeDeploymentRecords,
  readHomeDeploymentRecord,
  readHomeDeploymentReport,
  recoverDockerDeploymentRecords,
  type DockerInspectionResult
} from "../deployment/index.js";
import {
  extractImageReport,
  parseDistributionReport,
  projectImageOrganizationView,
  renderImageInterface
} from "../distribution/index.js";
import {
  collectCompiledProbeObservations,
  collectDeploymentLogObservations,
  collectMoltnetProbeObservations,
  collectRegistryDriftObservations,
  collectRuntimeProbeObservations,
  createDeploymentSummaries,
  createStaticStatus,
  exitCodeForStatus,
  flattenOrganizationNodes,
  loadedImageCompileReport,
  loadCompileReport,
  renderStatus,
  unavailableCompiledProbeFile,
  type StatusCommandResult,
  type StatusOutputMode
} from "../status/index.js";
import { errorExitCode, SpawnfileError } from "../shared/index.js";

import {
  statusInputFailure,
  type StatusCommandHandlers,
  type StatusCommandHandlersWithLive,
  type StatusCommandLiveHandlers,
  type StatusCommandOptions
} from "./statusCommandOptions.js";

export type LoadedDeploymentRecord = Awaited<ReturnType<typeof listDeploymentRecords>>[number];

export const resolveDeploymentRecords = (
  records: LoadedDeploymentRecord[],
  options: StatusCommandOptions
): LoadedDeploymentRecord[] | StatusCommandResult => {
  if (options.deployment) {
    const record = records.find((entry) => entry.record.name === options.deployment);
    return record
      ? [record]
      : statusInputFailure(`Unknown deployment "${options.deployment}". Valid deployments: ${
          records.map((entry) => entry.record.name).sort().join(", ") || "none"
        }`);
  }

  if (options.live && records.length > 1) {
    return statusInputFailure(`status --live requires --deployment when multiple records exist: ${
      records.map((entry) => entry.record.name).sort().join(", ")
    }`);
  }

  return records;
};

export const inspectDeployments = async (
  records: LoadedDeploymentRecord[],
  handlers: StatusCommandLiveHandlers,
  options: StatusCommandOptions,
  timeoutMs: number | undefined
): Promise<Map<string, DockerInspectionResult>> => {
  if (!options.live) {
    return new Map();
  }

  const inspect = handlers.inspectDockerDeployment ?? inspectDockerDeployment;
  const inspections = await Promise.all(records.map(async ({ record }) => [
    record.name,
    await inspect(record, {
      dockerCommand: options.dockerCommand,
      timeoutMs
    })
  ] as const));
  return new Map(inspections);
};

const containsFromView = (view: OrganizationView): Array<{ id: string; kind: "agent" | "team" }> =>
  flattenOrganizationNodes(view).map((node) => ({ id: node.id, kind: node.kind }));

const runtimeInstanceIdsFromReport = (
  loadedReport: Awaited<ReturnType<typeof loadCompileReport>>
): string[] =>
  loadedReport.kind === "loaded"
    ? loadedReport.report.runtimeInstances.map((instance) => instance.id).sort()
    : [];

export const recoverContextDeployments = async (
  input: {
    handlers: StatusCommandLiveHandlers;
    loadedReport: Awaited<ReturnType<typeof loadCompileReport>>;
    options: StatusCommandOptions;
    outputDirectory: string;
    projectLabel: string;
    sourceRoot: string;
    timeoutMs: number | undefined;
    view: OrganizationView;
  }
): Promise<LoadedDeploymentRecord[]> => {
  const recover = input.handlers.recoverDockerDeploymentRecords ?? recoverDockerDeploymentRecords;
  return recover({
    contains: containsFromView(input.view),
    context: input.options.context!,
    dockerCommand: input.options.dockerCommand,
    outputDirectory: input.outputDirectory,
    projectLabel: input.projectLabel,
    runtimeInstanceIds: runtimeInstanceIdsFromReport(input.loadedReport),
    sourceRoot: input.sourceRoot,
    timeoutMs: input.timeoutMs
  });
};

export const resolveStatusAuthValues = async (
  records: LoadedDeploymentRecord[],
  handlers: StatusCommandHandlers
): Promise<Record<string, string>> => {
  const values: Record<string, string> = {};
  if (!handlers.requireAuthProfile) {
    return values;
  }

  const profileNames = [...new Set(records
    .map(({ record }) => record.auth_profile)
    .filter((profileName): profileName is string => typeof profileName === "string" && profileName.length > 0))];
  for (const profileName of profileNames) {
    try {
      const profile = await handlers.requireAuthProfile(profileName);
      Object.assign(values, profile.env);
    } catch {
      // Missing profile values are reported by the metadata layer as unknown credentials.
    }
  }
  return values;
};

/* v8 ignore start -- docker extraction is covered by distribution E2E */
export const runStaticImageStatus = async (
  imageRef: string,
  options: StatusCommandOptions,
  json: boolean
): Promise<StatusCommandResult> => {
  try {
    const inspection = await extractImageReport(imageRef, {
      dockerCommand: options.dockerCommand,
      dockerContext: options.context,
      pull: options.pull
    });
    return {
      exitCode: 0,
      output: renderImageInterface(inspection.report, { imageRef, json })
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      exitCode: errorExitCode(error)
    };
  }
};
/* v8 ignore stop */

export const runHomeDeploymentStatus = async (
  options: StatusCommandOptions,
  handlers: StatusCommandHandlersWithLive,
  mode: StatusOutputMode,
  timeoutMs: number | undefined
): Promise<StatusCommandResult> => {
  let records: Awaited<ReturnType<typeof listHomeDeploymentRecords>>;
  try {
    records = await listHomeDeploymentRecords();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), exitCode: errorExitCode(error) };
  }

  if (!options.deployment) {
    if (records.length === 0) {
      return statusInputFailure("No image deployments found in the home store");
    }
    if (records.length > 1) {
      return statusInputFailure(`status --deployment is required: ${
        records.map((entry) => entry.record.name).sort().join(", ")
      }`);
    }
  }
  const targetName = options.deployment ?? records[0]!.record.name;
  const match = records.find((entry) => entry.record.name === targetName);
  if (!match) {
    return statusInputFailure(`Unknown deployment "${targetName}". Valid deployments: ${
      records.map((entry) => entry.record.name).sort().join(", ") || "none"
    }`);
  }

  let report;
  try {
    const record = await readHomeDeploymentRecord(targetName);
    void record;
    const raw = await readHomeDeploymentReport(targetName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SpawnfileError(
        "validation_error",
        `Cached report for "${targetName}" is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    report = parseDistributionReport(parsed);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), exitCode: errorExitCode(error) };
  }

  const view = projectImageOrganizationView(report, match.record.source.kind === "image"
    ? match.record.source.ref
    : targetName);
  const reportPath = match.path.replace(/record\.json$/, "spawnfile-report.json");
  const loadedReport = loadedImageCompileReport(report, reportPath);
  const selectedRecords = [match];

  const deploymentInspections = await inspectDeployments(selectedRecords, handlers, options, timeoutMs);
  const recordValues = selectedRecords.map(({ record }) => record);
  const authValues = options.live ? await resolveStatusAuthValues(selectedRecords, handlers) : {};
  const collectRuntimeProbes = handlers.collectRuntimeProbeObservations ?? collectRuntimeProbeObservations;
  const collectMoltnetProbes = handlers.collectMoltnetProbeObservations ?? collectMoltnetProbeObservations;
  const collectDeploymentLogs = handlers.collectDeploymentLogObservations ?? collectDeploymentLogObservations;
  const liveObservations = options.live && !options.recover
    ? [
        ...await collectRuntimeProbes({
          deployments: recordValues,
          inspections: deploymentInspections,
          loadedReport,
          timeoutMs
        }),
        ...await collectMoltnetProbes({
          authValues,
          deployments: recordValues,
          inspections: deploymentInspections,
          loadedReport,
          timeoutMs
        }),
        ...(options.logs
          ? await collectDeploymentLogs({
            deployments: recordValues,
            dockerCommand: options.dockerCommand,
            loadedReport,
            timeoutMs
          })
          : []),
        ...(options.pullCheck
          ? await collectRegistryDriftObservations({
            deployments: recordValues,
            dockerCommand: options.dockerCommand,
            timeoutMs
          })
          : [])
      ]
    : [];

  const compiledProbeObservations = await collectCompiledProbeObservations(
    loadedReport,
    null,
    unavailableCompiledProbeFile,
    handlers.compiledProbeCollectors
  );

  const status = createStaticStatus(view, loadedReport, {
    compiledProbeObservations,
    deployments: createDeploymentSummaries(selectedRecords, deploymentInspections),
    inputPath: view.inputPath,
    live: {
      context: null,
      deploymentName: targetName,
      logs: options.logs ?? false,
      recover: false,
      requested: options.live ?? false
    },
    liveObservations,
    outputDirectory: "",
    selection: null
  });

  return { exitCode: exitCodeForStatus(status), output: renderStatus(status, { mode }), status };
};
