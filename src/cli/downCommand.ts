import path from "node:path";

import type { Command } from "commander";

import {
  createDeploymentLifecycleCorrelation,
  findLifecycleInvocation,
  readDeploymentRecordFromOutput,
  type DeploymentLifecycleCorrelation,
  type DownReceipt,
  type LifecycleInvocation,
} from "../deployment/index.js";
import { resolveProjectOutputDirectory } from "../filesystem/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, SpawnfileError } from "../shared/index.js";
import { canonicalLifecycleJson } from "../deployment/lifecycleCompletionContracts.js";

import {
  createLifecycleInvocation,
  requireMachineLifecycle,
  runMachineLifecycle,
} from "./lifecycleMachine.js";
import type { CliHandlers, CliStreams } from "./runCli.js";

export interface DownOptions {
  compiled?: string;
  deployment: string;
  dockerCommand?: string;
  exportTo?: string;
  force?: boolean;
  json?: boolean;
  lifecycleInvocation?: string;
  readerImage?: string;
  timeout?: string;
  volumes?: boolean;
}

export const createDownLifecyclePolicy = (options: DownOptions) => ({
  docker_command: options.dockerCommand ?? null,
  export_to: options.exportTo ? path.resolve(options.exportTo) : null,
  force: options.force ?? false,
  reader_image: options.readerImage ?? null,
  remove_volumes: options.volumes ?? false,
  timeout_ms: options.timeout ? Number(options.timeout) : null,
});

export const createDownLifecycleInvocation = (
  id: string,
  compiledOutputDirectory: string,
  options: DownOptions,
  correlation: DeploymentLifecycleCorrelation,
): LifecycleInvocation =>
  createLifecycleInvocation(
    id,
    "down",
    {
      compiled_output_directory: compiledOutputDirectory,
      ...correlation,
    },
    createDownLifecyclePolicy(options),
  );

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
  ) {
    throw new SpawnfileError(
      "runtime_error",
      "Invalid stored down correlation",
    );
  }
  return {
    compile_fingerprint: value.compile_fingerprint,
    deployment: value.deployment,
    deployment_instance_digest: value.deployment_instance_digest,
    run_id: value.run_id,
    target: value.target,
  };
};

const assertExactRequest = (
  stored: LifecycleInvocation,
  compiledOutputDirectory: string,
  options: DownOptions,
): void => {
  if (
    stored.operation !== "down" ||
    stored.correlation.compiled_output_directory !== compiledOutputDirectory ||
    stored.correlation.deployment !== options.deployment ||
    JSON.stringify(stored.request_policy) !==
      JSON.stringify(createDownLifecyclePolicy(options))
  ) {
    throw new SpawnfileError("runtime_error", "Lifecycle invocation id drift");
  }
};

export const registerDownCommand = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams,
): void => {
  program
    .command("down")
    .description(
      "Tear down a recorded deployment; named volumes are retained by default.",
    )
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .requiredOption(
      "--deployment <name>",
      "Deployment record name to tear down",
    )
    .option("--compiled <directory>", "Compile output directory")
    .option("--docker-command <command>", "Docker command")
    .option("--export-to <directory>", "Export first, then tear down")
    .option("--force", "Discard un-exported artifacts")
    .option(
      "--reader-image <image>",
      "Image used to read named volumes during auto export",
    )
    .option("--timeout <ms>", "Bound each Docker call in milliseconds")
    .option("--volumes", "Also remove named volumes")
    .option(
      "--json",
      "Render a spawnfile.down-receipt.v1 machine-readable receipt",
    )
    .option(
      "--lifecycle-invocation <id>",
      "Durably bind this exact JSON lifecycle invocation",
    )
    .action(async (inputPath: string, options: DownOptions) => {
      requireMachineLifecycle(options.lifecycleInvocation, options.json);
      const compiled = resolveProjectOutputDirectory(
        inputPath,
        options.compiled,
        DEFAULT_OUTPUT_DIRECTORY,
      );
      const render = async (
        expected?: DeploymentLifecycleCorrelation,
      ): Promise<string> => {
        const expectedUnits = expected
          ? (await readDeploymentRecordFromOutput(
              compiled,
              options.deployment,
            )).units.map((unit) => unit.id).sort()
          : undefined;
        const receipt: DownReceipt = await handlers.downDeployment({
          compiledOutputDirectory: compiled,
          deploymentName: options.deployment,
          dockerCommand: options.dockerCommand,
          exportTo: options.exportTo,
          force: options.force,
          readerImage: options.readerImage,
          removeVolumes: options.volumes,
          timeoutMs: options.timeout ? Number(options.timeout) : undefined,
          ...(expected ? { expectedLifecycleCorrelation: expected } : {}),
        });
        if (
          expectedUnits !== undefined &&
          (receipt.errors.length !== 0 ||
            (options.volumes === true &&
              receipt.retained_volumes.length !== 0) ||
            JSON.stringify([...receipt.units_stopped].sort()) !==
              JSON.stringify(expectedUnits))
        ) {
          throw new SpawnfileError(
            "runtime_error",
            "Lifecycle down is incomplete and remains retryable",
          );
        }
        return JSON.stringify(receipt, null, 2);
      };
      if (options.json && options.lifecycleInvocation) {
        const stored = await findLifecycleInvocation(
          options.lifecycleInvocation,
        );
        let exact: LifecycleInvocation;
        let correlation: DeploymentLifecycleCorrelation;
        if (stored) {
          assertExactRequest(stored, compiled, options);
          exact = stored;
          correlation = correlationFrom(stored);
        } else {
          const record = await readDeploymentRecordFromOutput(
            compiled,
            options.deployment,
          );
          correlation = createDeploymentLifecycleCorrelation(record);
          exact = createDownLifecycleInvocation(
            options.lifecycleInvocation,
            compiled,
            options,
            correlation,
          );
        }
        const output = await runMachineLifecycle(
          exact,
          () => render(correlation),
          async () => {
            try {
              const current = createDeploymentLifecycleCorrelation(
                await readDeploymentRecordFromOutput(
                  compiled,
                  options.deployment,
                ),
              );
              return canonicalLifecycleJson(current) ===
                canonicalLifecycleJson(correlation)
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
          },
        );
        streams.stdout(output);
        return;
      }
      const output = await render();
      if (options.json) {
        streams.stdout(output);
        return;
      }
      const receipt = JSON.parse(output) as DownReceipt;
      streams.stdout(`deployment: ${receipt.deployment}`);
      receipt.units_stopped.forEach((unit) =>
        streams.stdout(`stopped: ${unit}`),
      );
      receipt.retained_volumes.forEach((volume) =>
        streams.stdout(`retained volume: ${volume}`),
      );
      receipt.errors.forEach((error) => streams.stderr(`error: ${error}`));
    });
};
