import path from "node:path";

import { Command } from "commander";

import {
  inspectDockerDeployment,
  listDeploymentRecords,
  listHomeDeploymentRecords,
  readHomeDeploymentRecord,
  readHomeDeploymentReport,
  type DockerInspectionResult
} from "../deployment/index.js";
import {
  extractImageReport,
  parseDistributionReport,
  projectImageOrganizationView,
  renderImageInterface
} from "../distribution/index.js";
import { collectRegistryDriftObservations } from "../status/index.js";
import { resolveProjectOutputDirectory } from "../filesystem/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, errorExitCode } from "../shared/index.js";

import { resolveCommandInput } from "./resolveCommandInput.js";
import { loadedImageCompileReport } from "../status/index.js";
import {
  createStaticStatus,
  createDeploymentSummaries,
  collectDeploymentLogObservations,
  collectMoltnetProbeObservations,
  collectRuntimeProbeObservations,
  exitCodeForStatus,
  loadCompileReport,
  renderStatus,
  resolveStatusSelector,
  type StatusCommandResult,
  type StatusExitCode,
  type StatusOutputMode,
  type StatusSelectorInput
} from "../status/index.js";
import type { CliHandlers, CliStreams } from "./runCli.js";

type StatusCommandHandlers = Pick<CliHandlers, "buildOrganizationView"> & Partial<Pick<CliHandlers, "requireAuthProfile">>;
type StatusCommandLiveHandlers = {
  collectDeploymentLogObservations?: typeof collectDeploymentLogObservations;
  collectMoltnetProbeObservations?: typeof collectMoltnetProbeObservations;
  collectRuntimeProbeObservations?: typeof collectRuntimeProbeObservations;
  inspectDockerDeployment?: typeof inspectDockerDeployment;
};
type StatusCommandHandlersWithLive = StatusCommandHandlers & StatusCommandLiveHandlers;

export interface StatusCommandOptions {
  agent?: string;
  context?: string;
  deployment?: string;
  dockerCommand?: string;
  image?: boolean;
  json?: boolean;
  live?: boolean;
  logs?: boolean;
  network?: string;
  out?: string;
  pretty?: boolean;
  pull?: boolean;
  pullCheck?: boolean;
  quiet?: boolean;
  recover?: boolean;
  runtime?: string;
  team?: string;
  timeout?: string;
  watch?: boolean;
}

const inputFailure = (message: string): StatusCommandResult => ({
  error: message,
  exitCode: 2
});

const resolveOutputMode = (options: StatusCommandOptions): StatusOutputMode | StatusCommandResult => {
  const modes: StatusOutputMode[] = [
    ...(options.json ? ["json" as const] : []),
    ...(options.pretty ? ["pretty" as const] : []),
    ...(options.quiet ? ["quiet" as const] : [])
  ];

  if (modes.length > 1) {
    return inputFailure("Choose only one status output mode: --pretty, --json, or --quiet");
  }

  return modes[0] ?? "pretty";
};

const resolveSelectorInput = (
  options: StatusCommandOptions
): StatusSelectorInput | null | StatusCommandResult => {
  const selectors = [
    ...(options.agent ? [{ kind: "agent" as const, value: options.agent }] : []),
    ...(options.team ? [{ kind: "team" as const, value: options.team }] : []),
    ...(options.network ? [{ kind: "network" as const, value: options.network }] : []),
    ...(options.runtime ? [{ kind: "runtime" as const, value: options.runtime }] : [])
  ];

  if (selectors.length > 1) {
    return inputFailure("Choose only one status selector: --agent, --team, --network, or --runtime");
  }

  return selectors[0] ?? null;
};

const resolveTimeoutMs = (
  options: StatusCommandOptions
): number | undefined | StatusCommandResult => {
  if (!options.timeout) {
    return undefined;
  }
  const parsed = Number(options.timeout);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return inputFailure("status --timeout must be a positive integer number of milliseconds");
  }
  return parsed;
};

type LoadedDeploymentRecord = Awaited<ReturnType<typeof listDeploymentRecords>>[number];

const resolveDeploymentRecords = (
  records: LoadedDeploymentRecord[],
  options: StatusCommandOptions
): LoadedDeploymentRecord[] | StatusCommandResult => {
  if (options.deployment) {
    const record = records.find((entry) => entry.record.name === options.deployment);
    return record
      ? [record]
      : inputFailure(`Unknown deployment "${options.deployment}". Valid deployments: ${
          records.map((entry) => entry.record.name).sort().join(", ") || "none"
        }`);
  }

  if (options.live && records.length > 1) {
    return inputFailure(`status --live requires --deployment when multiple records exist: ${
      records.map((entry) => entry.record.name).sort().join(", ")
    }`);
  }

  return records;
};

const inspectDeployments = async (
  records: LoadedDeploymentRecord[],
  handlers: StatusCommandLiveHandlers,
  options: StatusCommandOptions,
  timeoutMs: number | undefined
): Promise<Map<string, DockerInspectionResult>> => {
  if (!options.live || options.recover) {
    return new Map();
  }

  const inspect = handlers.inspectDockerDeployment ?? inspectDockerDeployment;
  const inspections = await Promise.all(records.map(async ({ record }) => [
    record.name,
    await inspect(record, { timeoutMs })
  ] as const));
  return new Map(inspections);
};

const resolveAuthValues = async (
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

const emitOutput = (streams: CliStreams, output: string): void => {
  for (const line of output.split("\n")) {
    streams.stdout(line);
  }
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface StatusWatchOptions {
  intervalMs?: number;
  iterations?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const executeStatusWatch = async (
  inputPath: string,
  options: StatusCommandOptions,
  handlers: StatusCommandHandlersWithLive,
  streams: CliStreams,
  setExitCode: (exitCode: StatusExitCode) => void,
  watchOptions: StatusWatchOptions = {}
): Promise<void> => {
  const intervalMs = watchOptions.intervalMs ?? 5_000;
  const sleep = watchOptions.sleep ?? wait;
  let iteration = 0;
  while (watchOptions.iterations === undefined || iteration < watchOptions.iterations) {
    if (iteration > 0) {
      await sleep(intervalMs);
      streams.stdout("");
    }
    const result = await executeStatusCommand(inputPath, options, handlers);
    setExitCode(result.exitCode);
    if (result.error) {
      streams.stderr(`error: ${result.error}`);
      return;
    }
    if (result.output) {
      emitOutput(streams, result.output);
    }
    iteration += 1;
  }
};

/* v8 ignore start -- docker extraction is covered by distribution E2E */
const runStaticImageStatus = async (
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
    // Input errors (bad labels, non-JSON report, fingerprint mismatch) exit 2;
    // Docker/runtime failures (daemon down, pull/create failure) exit 1.
    return {
      error: error instanceof Error ? error.message : String(error),
      exitCode: errorExitCode(error)
    };
  }
};
/* v8 ignore stop */

const runHomeDeploymentStatus = async (
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
      return inputFailure("No image deployments found in the home store");
    }
    if (records.length > 1) {
      return inputFailure(`status --deployment is required: ${
        records.map((entry) => entry.record.name).sort().join(", ")
      }`);
    }
  }
  const targetName = options.deployment ?? records[0]!.record.name;
  const match = records.find((entry) => entry.record.name === targetName);
  if (!match) {
    return inputFailure(`Unknown deployment "${targetName}". Valid deployments: ${
      records.map((entry) => entry.record.name).sort().join(", ") || "none"
    }`);
  }

  let report;
  try {
    const record = await readHomeDeploymentRecord(targetName);
    void record;
    report = parseDistributionReport(JSON.parse(await readHomeDeploymentReport(targetName)));
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
  const authValues = options.live ? await resolveAuthValues(selectedRecords, handlers) : {};
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
          ? await collectDeploymentLogs({ deployments: recordValues, loadedReport, timeoutMs })
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

  const status = createStaticStatus(view, loadedReport, {
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

export const executeStatusCommand = async (
  inputPath: string,
  options: StatusCommandOptions,
  handlers: StatusCommandHandlersWithLive
): Promise<StatusCommandResult> => {
  const mode = resolveOutputMode(options);
  if (typeof mode !== "string") {
    return mode;
  }

  if (options.logs && !options.live) {
    return inputFailure("status --logs requires --live");
  }

  // A positional image reference without --deployment renders the static
  // interface from the embedded report. Image ref with --deployment, or a bare
  // --deployment on the default path, reads the home store.
  // A clear image reference (tag/digest/registry, or forced with --image)
  // without --deployment renders the static interface; any other positional is
  // treated as a project path (the view builder reports a missing path).
  const commandInput = resolveCommandInput(inputPath, { forceImage: options.image });
  const usedDefaultPath = inputPath === process.cwd();
  if (commandInput.kind === "image" && !options.deployment) {
    return runStaticImageStatus(commandInput.ref, options, mode === "json");
  }
  if (options.deployment && (commandInput.kind === "image" || usedDefaultPath)) {
    const timeoutForHome = resolveTimeoutMs(options);
    if (typeof timeoutForHome !== "number" && timeoutForHome !== undefined) {
      return timeoutForHome;
    }
    return runHomeDeploymentStatus(options, handlers, mode, timeoutForHome);
  }

  if (options.context && !options.recover) {
    return inputFailure("status accepts --context only with --recover");
  }
  if (options.logs && !options.live) {
    return inputFailure("status --logs requires --live");
  }
  if (options.logs && options.recover) {
    return inputFailure("status --logs is not available with --recover");
  }
  if (options.recover && !options.context) {
    return inputFailure("status --recover requires --context");
  }
  const timeoutMs = resolveTimeoutMs(options);
  if (typeof timeoutMs !== "number" && timeoutMs !== undefined) {
    return timeoutMs;
  }

  const selectorInput = resolveSelectorInput(options);
  if (selectorInput && "exitCode" in selectorInput) {
    return selectorInput;
  }

  const outputDirectory = resolveProjectOutputDirectory(
    inputPath,
    options.out,
    DEFAULT_OUTPUT_DIRECTORY
  );
  const view = await handlers.buildOrganizationView(inputPath);
  const selectorResult = resolveStatusSelector(view, selectorInput);
  if (selectorResult?.kind === "failure") {
    return { error: selectorResult.failure.message, exitCode: 2 };
  }

  const loadedReport = await loadCompileReport(outputDirectory);
  if (loadedReport.kind === "failure") {
    return { error: loadedReport.failure.message, exitCode: 2 };
  }
  let deploymentRecords: LoadedDeploymentRecord[];
  try {
    deploymentRecords = await listDeploymentRecords(outputDirectory);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      exitCode: 2
    };
  }
  const selectedDeploymentRecords = resolveDeploymentRecords(deploymentRecords, options);
  if ("exitCode" in selectedDeploymentRecords) {
    return selectedDeploymentRecords;
  }
  const deploymentInspections = await inspectDeployments(
    selectedDeploymentRecords,
    handlers,
    options,
    timeoutMs
  );
  const selectedDeploymentRecordValues = selectedDeploymentRecords.map(({ record }) => record);
  const authValues = options.live
    ? await resolveAuthValues(selectedDeploymentRecords, handlers)
    : {};
  const collectRuntimeProbes = handlers.collectRuntimeProbeObservations ?? collectRuntimeProbeObservations;
  const collectMoltnetProbes = handlers.collectMoltnetProbeObservations ?? collectMoltnetProbeObservations;
  const collectDeploymentLogs = handlers.collectDeploymentLogObservations ?? collectDeploymentLogObservations;
  const liveObservations = options.live && !options.recover
    ? [
        ...await collectRuntimeProbes({
          deployments: selectedDeploymentRecordValues,
          inspections: deploymentInspections,
          loadedReport,
          timeoutMs
        }),
        ...await collectMoltnetProbes({
          authValues,
          deployments: selectedDeploymentRecordValues,
          inspections: deploymentInspections,
          loadedReport,
          timeoutMs
        }),
        ...(options.logs
          ? await collectDeploymentLogs({
            deployments: selectedDeploymentRecordValues,
            loadedReport,
            timeoutMs
          })
          : [])
      ]
    : [];

  const status = createStaticStatus(view, loadedReport, {
    deployments: createDeploymentSummaries(selectedDeploymentRecords, deploymentInspections),
    inputPath,
    live: {
      context: options.context ?? null,
      deploymentName: options.deployment ?? null,
      logs: options.logs ?? false,
      recover: options.recover ?? false,
      requested: options.live ?? false
    },
    liveObservations,
    outputDirectory,
    selection: selectorResult?.selection ?? null
  });

  return {
    exitCode: exitCodeForStatus(status),
    output: renderStatus(status, { mode }),
    status
  };
};

export const registerStatusCommand = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams,
  setExitCode: (exitCode: StatusExitCode) => void
): void => {
  program
    .command("status")
    .description("Show static Spawnfile organization status")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--out <dir>", "Compile output directory")
    .option("--json", "Render machine-readable JSON")
    .option("--pretty", "Render human output")
    .option("--quiet", "Render only summary and non-ok observations")
    .option("--live", "Inspect the recorded live deployment")
    .option("--deployment <name>", "Deployment record name")
    .option("--image", "Interpret the argument as an image reference")
    .option("--pull", "Pull the image before inspecting (image references only)")
    .option("--pull-check", "Check the registry for a newer image digest (networked)")
    .option("--docker-command <command>", "Docker command")
    .option("--context <name>", "Docker context for label recovery only")
    .option("--recover", "Recover live status from labels instead of a deployment record")
    .option("--logs", "Include redacted logs when supported")
    .option("--timeout <ms>", "Bound live Docker/runtime checks in milliseconds")
    .option("--watch", "Refresh status every five seconds until interrupted")
    .option("--agent <id>", "Show one agent")
    .option("--team <id>", "Show one team")
    .option("--network <id>", "Show one network")
    .option("--runtime <name>", "Show one runtime")
    .action(async (inputPath: string, options: StatusCommandOptions) => {
      if (options.watch) {
        await executeStatusWatch(inputPath, options, handlers, streams, setExitCode);
        return;
      }
      const result = await executeStatusCommand(inputPath, options, handlers);
      setExitCode(result.exitCode);
      if (result.error) {
        streams.stderr(`error: ${result.error}`);
      }
      if (result.output) {
        emitOutput(streams, result.output);
      }
    });
};
