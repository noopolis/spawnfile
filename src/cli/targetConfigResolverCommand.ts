import type { Command } from "commander";

import { errorExitCode, SpawnfileError } from "../shared/index.js";

import {
  createTargetConfigResolutionBytes,
  resolveTargetConfig,
  type ResolveTargetConfigInput,
  type TargetConfigResolution,
} from "./targetConfigResolver.js";
import { formatCaughtTargetCliError } from "./targetReceiptOutput.js";
import type { SetTargetCommandExitCode, TargetCommandStreams } from "./targetCommands.js";

export const TARGET_CONFIG_RESOLVER_COMMAND = "resolve_config";

export type TargetConfigResolver = (
  input: ResolveTargetConfigInput
) => Promise<TargetConfigResolution>;

interface TargetConfigResolverCommandOptions {
  readonly allowRemotePull?: boolean;
  readonly baseImage?: string;
  readonly context?: string;
  readonly dockerCommand: string;
  readonly evidenceDestination: string;
  readonly preparedPlan?: string;
  readonly pull?: boolean;
  readonly timeoutMs: string;
}

const timeout = (value: string): number => {
  if (!/^[1-9][0-9]{0,5}$/u.test(value)) {
    throw new SpawnfileError(
      "validation_error",
      "Target timeout must be an integer from 1 to 120000 milliseconds"
    );
  }
  return Number(value);
};

export const registerTargetConfigResolverCommand = (
  target: Command,
  streams: TargetCommandStreams,
  setExitCode: SetTargetCommandExitCode,
  resolver: TargetConfigResolver = resolveTargetConfig
): void => {
  target.command(TARGET_CONFIG_RESOLVER_COMMAND)
    .description("Resolve one explicit Docker context and base image into target configuration")
    .option(
      "--context <name>",
      "Explicit named Docker context; omitted accepts only the current local context"
    )
    .option(
      "--base-image <reference>",
      "Portable base image reference; defaults to Spawnfile's standard world base"
    )
    .requiredOption(
      "--evidence-destination <path>",
      "Absolute private evidence archive destination"
    )
    .option("--docker-command <command>", "Docker-compatible command", "docker")
    .option("--timeout-ms <milliseconds>", "Bounded Docker command timeout", "10000")
    .option(
      "--prepared-plan <path>",
      "Absolute private composed target plan containing one prepared artifact mapping"
    )
    .option("--pull", "Explicitly pull the base image before inspection")
    .option(
      "--allow-remote-pull",
      "Allow --pull to mutate the explicitly named remote Docker context"
    )
    .action(async (options: TargetConfigResolverCommandOptions) => {
      try {
        const resolution = await resolver({
          allowRemotePull: options.allowRemotePull,
          baseImage: options.baseImage,
          context: options.context,
          dockerCommand: options.dockerCommand,
          evidenceDestination: options.evidenceDestination,
          preparedPlanPath: options.preparedPlan,
          pull: options.pull,
          timeoutMs: timeout(options.timeoutMs),
        });
        streams.stdout(createTargetConfigResolutionBytes(resolution));
      } catch (error) {
        streams.stderr(formatCaughtTargetCliError(
          error,
          "Target configuration resolution failed"
        ));
        setExitCode(errorExitCode(error));
      }
    });
};
