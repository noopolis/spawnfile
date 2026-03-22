import { Command } from "commander";

import type { ModelAuthMethod } from "../shared/index.js";
import { isSpawnfileError } from "../shared/index.js";

import { runDockerAuthE2E } from "./dockerAuth.js";
import type { E2ERuntime } from "./types.js";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const main = async (): Promise<void> => {
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
