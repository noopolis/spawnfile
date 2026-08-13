import path from "node:path";

import type { Command } from "commander";

import {
  exportRunArtifacts,
  findLifecycleInvocation,
  resolveArtifactsExportLifecycleCorrelation,
  type DeploymentLifecycleCorrelation,
  type ExportRunArtifactsResult,
  type LifecycleInvocation,
} from "../deployment/index.js";
import { resolveProjectOutputDirectory } from "../filesystem/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, SpawnfileError } from "../shared/index.js";
import { canonicalLifecycleJson } from "../deployment/lifecycleCompletionContracts.js";

import { runMachineLifecycle } from "./lifecycleMachine.js";
import type { CliStreams } from "./runCli.js";

export interface ArtifactsExportCommandOptions {
  compiled?: string;
  deployment?: string;
  dockerCommand?: string;
  includePrivate?: boolean;
  json?: boolean;
  lifecycleInvocation?: string;
  out: string;
  readerImage?: string;
  runId?: string;
  timeout?: string;
}

export interface ArtifactsCommandHandlers {
  exportRunArtifacts: typeof exportRunArtifacts;
}

export const createArtifactsExportLifecyclePolicy = (
  options: ArtifactsExportCommandOptions,
) => ({
  destination_directory: path.resolve(options.out),
  docker_command: options.dockerCommand ?? null,
  include_private: options.includePrivate === true,
  reader_image: options.readerImage ?? null,
  timeout_ms: options.timeout ? Number(options.timeout) : null,
});

export const createArtifactsExportLifecycleInvocation = (
  id: string,
  options: ArtifactsExportCommandOptions,
  compiled: string,
  correlation: DeploymentLifecycleCorrelation,
): LifecycleInvocation => ({
  correlation: {
    compiled_output_directory: compiled,
    deployment_selection: options.deployment ?? null,
    run_id_selection: options.runId ?? null,
    ...correlation,
  },
  id,
  operation: "artifacts_export",
  request_policy: createArtifactsExportLifecyclePolicy(options),
  version: "spawnfile.lifecycle-invocation.v1",
});

const correlationFrom = (
  stored: LifecycleInvocation,
): DeploymentLifecycleCorrelation => {
  const value = stored.correlation;
  if (
    typeof value.compile_fingerprint !== "string" ||
    typeof value.deployment_instance_digest !== "string" ||
    typeof value.deployment !== "string" ||
    (value.run_id !== null && typeof value.run_id !== "string") ||
    typeof value.target !== "string"
  )
    throw new SpawnfileError(
      "runtime_error",
      "Invalid stored export correlation",
    );
  return {
    compile_fingerprint: value.compile_fingerprint,
    deployment: value.deployment,
    deployment_instance_digest: value.deployment_instance_digest,
    run_id: value.run_id,
    target: value.target,
  };
};

const renderJson = (result: ExportRunArtifactsResult): string =>
  JSON.stringify(
    {
      deployment: result.deploymentName,
      failed_files: result.failedFiles,
      index: result.index,
      index_path: result.indexPath,
      missing_optional_files: result.missingOptionalFiles,
    },
    null,
    2,
  );

const renderSummary = (result: ExportRunArtifactsResult): string[] => [
  `exported ${result.index.files.length} file(s) to ${result.indexPath.replace(
    /[/\\]spawnfile[/\\]export-index\.json$/,
    "",
  )}`,
  `deployment: ${result.deploymentName}`,
  `run: ${result.index.run_id}`,
  `index: ${result.indexPath}`,
  ...result.missingOptionalFiles.map(
    (file) => `skipped (not present yet): ${file}`,
  ),
  ...result.failedFiles.map((file) => `FAILED to export: ${file}`),
];

export const registerArtifactsCommands = (
  program: Command,
  handlers: ArtifactsCommandHandlers,
  streams: CliStreams,
): void => {
  program
    .command("artifacts")
    .description("Manage a run's durable artifacts")
    .command("export")
    .description("Egress a run's durable artifacts")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .requiredOption("--out <directory>", "Destination run directory")
    .option("--deployment <name>", "Deployment record name")
    .option("--run-id <id>", "Run id")
    .option("--compiled <directory>", "Compile output directory")
    .option("--docker-command <command>", "Docker command")
    .option("--include-private", "Export unredacted private runtime training artifacts")
    .option("--reader-image <image>", "Image used to read named volumes")
    .option("--timeout <ms>", "Bound each Docker call in milliseconds")
    .option("--json", "Render machine-readable JSON")
    .option("--lifecycle-invocation <id>", "Bind this exact JSON invocation")
    .action(async (inputPath: string, options: ArtifactsExportCommandOptions) => {
      if (options.lifecycleInvocation && !options.json)
        throw new SpawnfileError(
          "validation_error",
          "--lifecycle-invocation is only valid with --json",
        );
      const compiled = resolveProjectOutputDirectory(
        inputPath,
        options.compiled,
        DEFAULT_OUTPUT_DIRECTORY,
      );
      const base = {
        compiledOutputDirectory: compiled,
        deploymentName: options.deployment,
        destinationDirectory: options.out,
        dockerCommand: options.dockerCommand,
        includePrivate: options.includePrivate,
        readerImage: options.readerImage,
        runId: options.runId,
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
      };
      if (!options.json) {
        for (const line of renderSummary(await handlers.exportRunArtifacts(base)))
          streams.stdout(line);
        return;
      }
      const render = async (expected?: DeploymentLifecycleCorrelation) =>
        renderJson(
          await handlers.exportRunArtifacts({
            ...base,
            ...(expected ? { expectedLifecycleCorrelation: expected } : {}),
          }),
        );
      if (!options.lifecycleInvocation) {
        streams.stdout(await render());
        return;
      }
      const stored = await findLifecycleInvocation(options.lifecycleInvocation);
      let exact: LifecycleInvocation;
      let correlation: DeploymentLifecycleCorrelation;
      if (stored) {
        correlation = correlationFrom(stored);
        exact = createArtifactsExportLifecycleInvocation(
          options.lifecycleInvocation,
          options,
          compiled,
          correlation,
        );
        if (
          canonicalLifecycleJson(exact) !== canonicalLifecycleJson(stored)
        )
          throw new SpawnfileError(
            "runtime_error",
            "Lifecycle invocation id drift",
          );
      } else {
        correlation = await resolveArtifactsExportLifecycleCorrelation(base);
        exact = createArtifactsExportLifecycleInvocation(
          options.lifecycleInvocation,
          options,
          compiled,
          correlation,
        );
      }
      streams.stdout(
        await runMachineLifecycle(exact, () => render(correlation), async () => {
          try {
            const current =
              await resolveArtifactsExportLifecycleCorrelation(base);
            return JSON.stringify(current) === JSON.stringify(correlation)
              ? { status: "resume_safe" as const }
              : {
                  reason: "deployment_correlation_changed",
                  status: "ambiguous" as const,
                };
          } catch {
            return {
              reason: "deployment_correlation_unavailable",
              status: "ambiguous" as const,
            };
          }
        }),
      );
    });
};
