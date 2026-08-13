import { Command } from "commander";

import { runMoltnetMemeticsE2E } from "./moltnetMemetics.js";
import { runMoltnetTeamChatE2E } from "./moltnetTeamChat.js";

export const runMoltnetTeamChatCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile-e2e moltnet-team-chat")
    .description("Run the opt-in Moltnet team-chat conversation E2E")
    .option("--auth-profile <name>", "Existing auth profile name when --no-sync-auth is used")
    .option("--child-base-url <url>", "Child Moltnet base URL", "http://127.0.0.1:8788")
    .option("--claude-from <directory>", "Claude Code config directory override")
    .option("--codex-from <directory>", "Codex config directory override")
    .option("--container-name <name>", "Docker container name")
    .option("--docker-command <command>", "Docker command", "docker")
    .option("--env-file <path>", "Env file for api_key scenarios")
    .option("--fixture <path>", "Fixture directory override")
    .option("--image-tag <tag>", "Docker image tag")
    .option("--keep-artifacts", "Keep temporary compile output")
    .option("--keep-images", "Keep built Docker image")
    .option("--parent-base-url <url>", "Parent Moltnet base URL", "http://127.0.0.1:8787")
    .option("--no-sync-auth", "Use an existing auth profile instead of syncing auth into a temp profile")
    .option("--poll-interval-ms <ms>", "Moltnet poll interval", Number)
    .option("--timeout-ms <ms>", "Moltnet/runtime readiness timeout", Number);

  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{
    authProfile?: string;
    childBaseUrl?: string;
    claudeFrom?: string;
    codexFrom?: string;
    containerName?: string;
    dockerCommand?: string;
    envFile?: string;
    fixture?: string;
    imageTag?: string;
    keepArtifacts?: boolean;
    keepImages?: boolean;
    parentBaseUrl?: string;
    pollIntervalMs?: number;
    syncAuth?: boolean;
    timeoutMs?: number;
  }>();

  const result = await runMoltnetTeamChatE2E({
    authProfileName: options.authProfile,
    childBaseUrl: options.childBaseUrl,
    claudeCodeDirectory: options.claudeFrom,
    codexDirectory: options.codexFrom,
    containerName: options.containerName,
    dockerCommand: options.dockerCommand,
    envFilePath: options.envFile,
    fixtureDirectory: options.fixture,
    imageTag: options.imageTag,
    keepArtifacts: options.keepArtifacts,
    keepImages: options.keepImages,
    parentBaseUrl: options.parentBaseUrl,
    pollIntervalMs: options.pollIntervalMs,
    syncAuth: options.syncAuth,
    timeoutMs: options.timeoutMs
  });

  console.log(`Moltnet team-chat E2E passed (${result.sentinels.parentRequest})`);
};

export const runMoltnetMemeticsCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile-e2e moltnet-memetics")
    .description("Run the opt-in live Eleanor<->Sam Moltnet conversation E2E over real Codex")
    .option("--auth-profile <name>", "Existing auth profile name when --no-sync-auth is used")
    .option("--base-url <url>", "Moltnet base URL", "http://127.0.0.1:8787")
    .option("--claude-from <directory>", "Claude Code config directory override")
    .option("--codex-from <directory>", "Codex config directory override")
    .option("--container-name <name>", "Docker container name")
    .option("--docker-command <command>", "Docker command", "docker")
    .option("--env-file <path>", "Env file for api_key scenarios")
    .option("--fixture <path>", "Fixture directory override")
    .option("--image-tag <tag>", "Docker image tag")
    .option("--keep-artifacts", "Keep temporary compile output")
    .option("--keep-images", "Keep built Docker image")
    .option("--out <path>", "Run folder to write the captured transcript/engine-logs into")
    .option("--no-sync-auth", "Use an existing auth profile instead of syncing auth into a temp profile")
    .option("--poll-interval-ms <ms>", "Moltnet poll interval", Number)
    .option("--quiet-grace-ms <ms>", "Grace period after the last agent turn before concluding no further reply is coming", Number)
    .option("--seed-token <token>", "High-entropy sentinel token planted in the operator seed message")
    .option("--target-turns <n>", "Agent turns to wait for before concluding the exchange is complete (min 3)", Number)
    .option("--timeout-ms <ms>", "Moltnet/runtime readiness timeout", Number);

  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{
    authProfile?: string;
    baseUrl?: string;
    claudeFrom?: string;
    codexFrom?: string;
    containerName?: string;
    dockerCommand?: string;
    envFile?: string;
    fixture?: string;
    imageTag?: string;
    keepArtifacts?: boolean;
    keepImages?: boolean;
    out?: string;
    pollIntervalMs?: number;
    quietGraceMs?: number;
    seedToken?: string;
    syncAuth?: boolean;
    targetTurns?: number;
    timeoutMs?: number;
  }>();

  const result = await runMoltnetMemeticsE2E({
    authProfileName: options.authProfile,
    baseUrl: options.baseUrl,
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
    quietGraceMs: options.quietGraceMs,
    runFolder: options.out,
    seedToken: options.seedToken,
    syncAuth: options.syncAuth,
    targetTurns: options.targetTurns,
    timeoutMs: options.timeoutMs
  });

  console.log(
    `Moltnet memetics E2E passed (turns=${result.agentTurns.length} ended=${result.endedReason} eleanor=${result.eleanorReply.id} sam=${result.samReply.id} run_folder=${result.runFolder})`
  );
};
