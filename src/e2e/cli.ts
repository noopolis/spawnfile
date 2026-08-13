import { Command } from "commander";

import { isSpawnfileError, type ModelAuthMethod } from "../shared/index.js";

import {
  runDaimonMemoryRecallCli,
  runJungianSelfOrgCli,
  runMixedRuntimeMemoryWiringCli,
  runOllamaEmbeddingsProbeCli
} from "./cliMemory.js";
import { runMoltnetMemeticsCli, runMoltnetTeamChatCli } from "./cliMoltnet.js";
import { runDaimonOrgCli, runLifecycleSmokeCli, runOperationalSmokeCli } from "./cliSmoke.js";
import { runDistributionImageE2E } from "./distributionImage.js";
import { runDistributionRoundtripE2E } from "./distributionRoundtrip.js";
import { runDockerAuthE2E } from "./dockerAuth.js";
import { runPreflightCli } from "./preflightCli.js";
import type { E2ERuntime } from "./types.js";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const dispatchNamedCommand = async (name: string | undefined, argv: string[]): Promise<boolean> => {
  const commands = new Map<string, (args: string[]) => Promise<void>>([
    ["daimon-memory-recall", runDaimonMemoryRecallCli],
    ["daimon-org", runDaimonOrgCli],
    ["jungian-self-org", runJungianSelfOrgCli],
    ["lifecycle-smoke", runLifecycleSmokeCli],
    ["mixed-runtime-memory", runMixedRuntimeMemoryWiringCli],
    ["moltnet-memetics", runMoltnetMemeticsCli],
    ["moltnet-team-chat", runMoltnetTeamChatCli],
    ["ollama-embeddings-probe", runOllamaEmbeddingsProbeCli],
    ["operational-smoke", runOperationalSmokeCli],
    ["preflight", runPreflightCli]
  ]);
  const command = name ? commands.get(name) : undefined;
  if (!command) return false;
  await command(argv);
  return true;
};

const main = async (): Promise<void> => {
  if (await dispatchNamedCommand(process.argv[2], process.argv.slice(3))) return;

  if (process.argv[2] === "distribution-image") {
    const result = await runDistributionImageE2E();
    console.log(`Distribution image E2E passed (${result.imageTag})`);
    return;
  }
  if (process.argv[2] === "distribution-roundtrip") {
    const result = await runDistributionRoundtripE2E();
    console.log(`Distribution roundtrip E2E passed (${result.imageRef})`);
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
    : error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
