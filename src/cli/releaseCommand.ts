import type { Command } from "commander";

import {
  createDefaultReleaseDependencies,
  releaseExitCode,
  resolveNotifierConfig,
  runRelease,
  type ReleaseDependencies,
  type ReleaseRequest
} from "../release/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { CliStreams } from "./runCli.js";

const UNITS: Record<string, number> = { h: 3_600_000, m: 60_000, ms: 1, s: 1_000 };

/** `90s`, `30m`, `2h`, `500ms`. A bare number is refused: the unit is never guessed. */
export const parseReleaseDuration = (value: string, flag: string): number => {
  const match = /^(\d+)(ms|s|m|h)$/u.exec(value.trim());
  if (!match) throw new SpawnfileError("validation_error", `${flag} must be a duration like 90s, 30m or 2h`);
  const ms = Number(match[1]) * UNITS[match[2]!]!;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new SpawnfileError("validation_error", `${flag} must be positive`);
  return ms;
};

interface ReleaseCommandOptions {
  authProfile?: string;
  context?: string;
  deployment: string;
  devInputs?: boolean;
  dockerCommand?: string;
  drain: boolean;
  drainTimeout: string;
  envFile?: string;
  force?: boolean;
  imageRepository?: string;
  notifyCommand?: string;
  notifyDeferredAfter: string;
  notifyWebhookEnv?: string;
  out?: string;
}

export const registerReleaseCommand = (
  program: Command,
  streams: CliStreams,
  setExitCode: (code: number) => void,
  dependencies: () => ReleaseDependencies = createDefaultReleaseDependencies
): void => {
  program
    .command("release")
    .description("Build and deploy only when the image inputs changed, draining running turns first")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .requiredOption("--deployment <name>", "Detached deployment to release into")
    .option("--env-file <file>", "Runtime secrets; must set SPAWNFILE_DAIMON_CONTROL_TOKEN to drain")
    .option("--auth-profile <name>", "Local Spawnfile auth profile")
    .option("--context <name>", "Docker context for the build and deployment target")
    .option("--docker-command <command>", "Docker command")
    .option("-o, --out <directory>", "Compile output directory")
    .option("--image-repository <name>", "Repository for release image tags (default spawnfile-<project>)")
    .option("--drain-timeout <duration>", "How long running turns may take to finish before the release is abandoned", "30m")
    .option("--no-drain", "Deploy without draining (kills in-flight turns)")
    .option("--force", "Release even when the running identity is unchanged")
    .option("--dev-inputs", "Hash working-tree bundle inputs instead of requiring a clean commit")
    .option("--notify-command <path>", "Executable run on failure; receives the notification JSON on stdin")
    .option("--notify-webhook-env <name>", "Environment variable holding an https URL to POST the notification to")
    .option("--notify-deferred-after <duration>", "Notify once when a release has been deferred this long", "24h")
    .action(async (inputPath: string, options: ReleaseCommandOptions) => {
      let notifier;
      try {
        notifier = resolveNotifierConfig(options);
      } catch (error) {
        throw new SpawnfileError("validation_error", (error as Error).message);
      }
      const drainTimeoutMs = parseReleaseDuration(options.drainTimeout, "--drain-timeout");
      const notifyDeferredAfterMs = parseReleaseDuration(options.notifyDeferredAfter, "--notify-deferred-after");
      const abort = new AbortController();
      const onSignal = (): void => abort.abort();
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      try {
        const request: ReleaseRequest = {
          authProfileName: options.authProfile ?? null,
          bundleIdentity: options.devInputs ? "dev" : "release",
          deployment: options.deployment,
          dockerCommand: options.dockerCommand ?? "docker",
          ...(options.context ? { dockerContext: options.context } : {}),
          drain: options.drain,
          drainPollMs: 5_000,
          drainTimeoutMs,
          envFileEnv: {},
          ...(options.envFile ? { envFilePath: options.envFile } : {}),
          force: options.force === true,
          ...(options.imageRepository ? { imageRepository: options.imageRepository } : {}),
          inputPath,
          log: streams.stdout,
          notifier,
          notifyDeferredAfterMs,
          ...(options.out ? { outputDirectory: options.out } : {}),
          settle: { pollMs: 5_000, polls: 36, stablePolls: 3 },
          signal: abort.signal
        };
        const outcome = await runRelease(request, dependencies());
        setExitCode(releaseExitCode(outcome));
      } finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
    });
};
