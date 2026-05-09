import { Command } from "commander";

import type { ModelAuthMethod } from "../shared/index.js";
import { isSpawnfileError } from "../shared/index.js";

import { runDockerAuthE2E } from "./dockerAuth.js";
import { runMoltnetTeamChatE2E } from "./moltnetTeamChat.js";
import { runOperationalSmokeE2E } from "./operationalSmoke.js";
import type { E2ERuntime } from "./types.js";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const runMoltnetTeamChatCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile-e2e moltnet-team-chat")
    .description("Run the opt-in Moltnet team-chat conversation E2E")
    .option("--auth-profile <name>", "Existing auth profile name when --no-sync-auth is used")
    .option("--claude-from <directory>", "Claude Code config directory override")
    .option("--codex-from <directory>", "Codex config directory override")
    .option("--container-name <name>", "Docker container name")
    .option("--docker-command <command>", "Docker command", "docker")
    .option("--env-file <path>", "Env file for api_key scenarios")
    .option("--fixture <path>", "Fixture directory override")
    .option("--image-tag <tag>", "Docker image tag")
    .option("--keep-artifacts", "Keep temporary compile output")
    .option("--keep-images", "Keep built Docker image")
    .option("--no-sync-auth", "Use an existing auth profile instead of syncing auth into a temp profile")
    .option("--poll-interval-ms <ms>", "Moltnet poll interval", Number)
    .option("--timeout-ms <ms>", "Moltnet/runtime readiness timeout", Number);

  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{
    authProfile?: string;
    claudeFrom?: string;
    codexFrom?: string;
    containerName?: string;
    dockerCommand?: string;
    envFile?: string;
    fixture?: string;
    imageTag?: string;
    keepArtifacts?: boolean;
    keepImages?: boolean;
    pollIntervalMs?: number;
    syncAuth?: boolean;
    timeoutMs?: number;
  }>();

  const result = await runMoltnetTeamChatE2E({
    authProfileName: options.authProfile,
    claudeCodeDirectory: options.claudeFrom,
    codexDirectory: options.codexFrom,
    containerName: options.containerName,
    dockerCommand: options.dockerCommand,
    envFilePath: options.envFile,
    fixtureDirectory: options.fixture,
    imageTag: options.imageTag,
    keepArtifacts: options.keepArtifacts,
    keepImages: options.keepImages,
    pollIntervalMs: options.pollIntervalMs,
    syncAuth: options.syncAuth,
    timeoutMs: options.timeoutMs
  });

  console.log(`Moltnet team-chat E2E passed (${result.sentinels.parentRequest})`);
};

const runOperationalSmokeCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile-e2e operational-smoke")
    .description("Run the opt-in Docker operational smoke E2E")
    .option("--container-name <name>", "Docker container name")
    .option("--docker-command <command>", "Docker command", "docker")
    .option("--fixture <path>", "Fixture directory override")
    .option("--image-tag <tag>", "Docker image tag")
    .option("--keep-artifacts", "Keep temporary compile output")
    .option("--keep-images", "Keep built Docker image")
    .option("--poll-interval-ms <ms>", "Poll interval", Number)
    .option("--timeout-ms <ms>", "Readiness/schedule timeout", Number);

  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{
    containerName?: string;
    dockerCommand?: string;
    fixture?: string;
    imageTag?: string;
    keepArtifacts?: boolean;
    keepImages?: boolean;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }>();

  const result = await runOperationalSmokeE2E({
    containerName: options.containerName,
    dockerCommand: options.dockerCommand,
    fixtureDirectory: options.fixture,
    imageTag: options.imageTag,
    keepArtifacts: options.keepArtifacts,
    keepImages: options.keepImages,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs
  });

  console.log(`Operational smoke E2E passed (${result.containerName})`);
};

const main = async (): Promise<void> => {
  if (process.argv[2] === "moltnet-team-chat") {
    await runMoltnetTeamChatCli(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === "operational-smoke") {
    await runOperationalSmokeCli(process.argv.slice(3));
    return;
  }

  const program = new Command();
  program
    .name("spawnfile-e2e")
    .description("Run opt-in Docker auth E2E scenarios against real runtime images")
    .option("--scenario <id>", "Scenario id to run", collect, [])
    .option("--runtime <runtime>", "Runtime filter", collect, [])
    .option("--auth <method>", "Auth method filter", collect, [])
    .option("--env-file <path>", "Env file for api_key scenarios")
    .option("--claude-from <directory>", "Claude Code config directory override")
    .option("--codex-from <directory>", "Codex config directory override")
    .option("--keep-artifacts", "Keep temporary projects and compile output")
    .option("--keep-images", "Keep built Docker images after each scenario");

  await program.parseAsync(process.argv);
  const options = program.opts<{
    auth: string[];
    claudeFrom?: string;
    codexFrom?: string;
    envFile?: string;
    keepArtifacts?: boolean;
    keepImages?: boolean;
    runtime: string[];
    scenario: string[];
  }>();

  const result = await runDockerAuthE2E({
    authMethods: options.auth as ModelAuthMethod[],
    claudeCodeDirectory: options.claudeFrom,
    codexDirectory: options.codexFrom,
    envFilePath: options.envFile,
    keepArtifacts: options.keepArtifacts,
    keepImages: options.keepImages,
    runtimes: options.runtime as E2ERuntime[],
    scenarioIds: options.scenario
  });

  console.log(`Docker auth E2E passed (${result.results.length} scenarios)`);
};

main().catch((error: unknown) => {
  const message = isSpawnfileError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
