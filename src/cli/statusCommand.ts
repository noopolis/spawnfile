import { Command } from "commander";

import { listDeploymentRecords } from "../deployment/index.js";
import { normalizeProjectLabelSlug } from "../distribution/index.js";
import { resolveProjectOutputDirectory } from "../filesystem/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, errorExitCode } from "../shared/index.js";
import {
  collectCompiledProbeObservations,
  collectDeploymentLogObservations,
  collectMoltnetProbeObservations,
  collectRuntimeProbeObservations,
  createDeploymentSummaries,
  createStaticStatus,
  exitCodeForStatus,
  loadCompileReport,
  readCompiledProbeFile,
  renderStatus,
  resolveStatusSelector,
  type StatusCommandResult,
  type StatusExitCode
} from "../status/index.js";

import { resolveCommandInput } from "./resolveCommandInput.js";
import type { CliHandlers, CliStreams } from "./runCli.js";
import {
  inspectDeployments,
  recoverContextDeployments,
  resolveDeploymentRecords,
  resolveStatusAuthValues,
  runHomeDeploymentStatus,
  runStaticImageStatus,
  type LoadedDeploymentRecord
} from "./statusCommandLive.js";
import {
  emitStatusOutput,
  resolveStatusOutputMode,
  resolveStatusSelectorInput,
  resolveStatusTimeoutMs,
  statusInputFailure,
  type StatusCommandHandlersWithLive,
  type StatusCommandOptions
} from "./statusCommandOptions.js";

export type { StatusCommandOptions } from "./statusCommandOptions.js";

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
      emitStatusOutput(streams, result.output);
    }
    iteration += 1;
  }
};

export const executeStatusCommand = async (
  inputPath: string,
  options: StatusCommandOptions,
  handlers: StatusCommandHandlersWithLive
): Promise<StatusCommandResult> => {
  const mode = resolveStatusOutputMode(options);
  if (typeof mode !== "string") {
    return mode;
  }

  if (options.logs && !options.live) {
    return statusInputFailure("status --logs requires --live");
  }

  const commandInput = resolveCommandInput(inputPath, { forceImage: options.image });
  const usedDefaultPath = inputPath === process.cwd();
  if (commandInput.kind === "image" && !options.deployment) {
    return runStaticImageStatus(commandInput.ref, options, mode === "json");
  }
  if (options.deployment && !options.context && (commandInput.kind === "image" || usedDefaultPath)) {
    const timeoutForHome = resolveStatusTimeoutMs(options);
    if (typeof timeoutForHome !== "number" && timeoutForHome !== undefined) {
      return timeoutForHome;
    }
    return runHomeDeploymentStatus(options, handlers, mode, timeoutForHome);
  }

  if (options.context && !options.live) {
    return statusInputFailure("status --context requires --live");
  }
  if (options.logs && !options.live) {
    return statusInputFailure("status --logs requires --live");
  }
  if (options.recover && !options.context) {
    return statusInputFailure("status --recover requires --context");
  }
  const timeoutMs = resolveStatusTimeoutMs(options);
  if (typeof timeoutMs !== "number" && timeoutMs !== undefined) {
    return timeoutMs;
  }

  const selectorInput = resolveStatusSelectorInput(options);
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
    deploymentRecords = options.context
      ? await recoverContextDeployments({
          handlers,
          loadedReport,
          options,
          outputDirectory,
          projectLabel: normalizeProjectLabelSlug(view.root.name),
          sourceRoot: view.root.source,
          timeoutMs,
          view
        })
      : await listDeploymentRecords(outputDirectory);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      exitCode: errorExitCode(error)
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
    ? await resolveStatusAuthValues(selectedDeploymentRecords, handlers)
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
            dockerCommand: options.dockerCommand,
            loadedReport,
            timeoutMs
          })
          : [])
      ]
    : [];

  const compiledProbeObservations = await collectCompiledProbeObservations(
    loadedReport,
    outputDirectory,
    readCompiledProbeFile,
    handlers.compiledProbeCollectors
  );

  const status = createStaticStatus(view, loadedReport, {
    compiledProbeObservations,
    deployments: createDeploymentSummaries(selectedDeploymentRecords, deploymentInspections),
    inputPath,
    live: {
      context: options.context ?? null,
      deploymentName: options.deployment ?? null,
      logs: options.logs ?? false,
      recover: options.recover === true || Boolean(options.context),
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
    .option("--context <name>", "Docker context for live remote deployment recovery")
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
        emitStatusOutput(streams, result.output);
      }
    });
};
