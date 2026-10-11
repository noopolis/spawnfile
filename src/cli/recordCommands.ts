import type { Command } from "commander";

import { resolveProjectOutputDirectory } from "../filesystem/index.js";
import { syncDeploymentMoments, type RecordingDeploymentHandlers } from "../recording/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, errorExitCode } from "../shared/index.js";
import type { CliStreams } from "./runCli.js";
import { selectUsageDeployment, type UsageCommandLiveHandlers } from "./usageCommandLive.js";
import { resolveUsageDeploymentSource } from "./usageDeploymentSource.js";

export interface RecordSyncOptions { deployment?: string; out?: string; dockerCommand?: string; timeout?: string }
export type RecordCommandHandlers = UsageCommandLiveHandlers & RecordingDeploymentHandlers;

export const executeRecordSyncCommand = async (
  inputPath: string, options: RecordSyncOptions, handlers: RecordCommandHandlers = {}
): Promise<{ exitCode: 0 | 1 | 2; output?: string; error?: string }> => {
  try {
    const timeoutMs = options.timeout === undefined ? undefined : Number(options.timeout);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return { exitCode: 2, error: "--timeout must be a positive number of milliseconds" };
    }
    const outputDirectory = resolveProjectOutputDirectory(inputPath, options.out, DEFAULT_OUTPUT_DIRECTORY);
    const source = await resolveUsageDeploymentSource(inputPath, options, handlers, outputDirectory);
    const records = await source.loader(source.outputDirectory);
    const record = selectUsageDeployment(records, options.deployment);
    if ("error" in record) return { exitCode: 2, error: record.error.replace("spawnfile usage", "spawnfile record sync") };
    const recordPath = records.find((entry) => entry.record === record)!.path;
    const result = await syncDeploymentMoments({ record, recordPath, timeoutMs, dockerCommand: options.dockerCommand }, handlers);
    return {
      exitCode: result.failures.length ? 1 : 0,
      output: `Records: ${result.written} written / ${result.skipped} skipped / ${result.nonExact} non-exact`,
      ...((result.failures.length || result.warnings.length) ? { error: [...result.failures, ...new Set(result.warnings)].join("\n") } : {})
    };
  } catch (error) {
    return { exitCode: errorExitCode(error), error: error instanceof Error ? error.message : String(error) };
  }
};

export const registerRecordCommands = (
  program: Command, streams: CliStreams, setExitCode: (code: 0 | 1 | 2) => void, handlers: RecordCommandHandlers = {}
): void => {
  program.command("record").description("Compose training moment records from deployed wake evidence")
    .command("sync").argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--deployment <name>", "Deployment record name").option("--out <dir>", "Compile output directory")
    .option("--docker-command <command>", "Docker command").option("--timeout <ms>", "Bound Docker reads in milliseconds")
    .action(async (inputPath: string, options: RecordSyncOptions) => {
      const result = await executeRecordSyncCommand(inputPath, options, handlers);
      setExitCode(result.exitCode);
      if (result.error) streams.stderr(result.error);
      if (result.output) streams.stdout(result.output);
    });
};
