import { Command } from "commander";

import { runDaimonOrgE2E } from "./daimonOrg.js";
import { runLifecycleSmokeE2E } from "./lifecycleSmoke.js";
import { runOperationalSmokeE2E } from "./operationalSmoke.js";

export const runLifecycleSmokeCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile-e2e lifecycle-smoke")
    .description("Run the opt-in spawnfile up/artifacts-export/down --json lifecycle smoke (zero behavior assertions)")
    .option("--container-name <name>", "Docker container name")
    .option("--deployment <name>", "Deployment record name")
    .option("--docker-command <command>", "Docker command", "docker")
    .option("--fixture <path>", "Fixture directory override")
    .option("--image-tag <tag>", "Docker image tag")
    .option("--keep-artifacts", "Keep temporary compile/run output")
    .option("--keep-images", "Keep built Docker image")
    .option("--poll-interval-ms <ms>", "Poll interval", Number)
    .option("--timeout-ms <ms>", "Readiness timeout", Number);

  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{
    containerName?: string;
    deployment?: string;
    dockerCommand?: string;
    fixture?: string;
    imageTag?: string;
    keepArtifacts?: boolean;
    keepImages?: boolean;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }>();
  const result = await runLifecycleSmokeE2E({
    containerName: options.containerName,
    deploymentName: options.deployment,
    dockerCommand: options.dockerCommand,
    fixtureDirectory: options.fixture,
    imageTag: options.imageTag,
    keepArtifacts: options.keepArtifacts,
    keepImages: options.keepImages,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs
  });
  console.log(
    `Lifecycle smoke E2E passed (run_id=${result.upReceipt.run_id} files=${result.exportIndex.files.length} units_stopped=${result.downReceipt.units_stopped.length})`
  );
};

export const runOperationalSmokeCli = async (argv: string[]): Promise<void> => {
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

export const runDaimonOrgCli = async (argv: string[]): Promise<void> => {
  const command = new Command();
  command
    .name("spawnfile-e2e daimon-org")
    .description("Run the opt-in legacy generated-Pi organization E2E against real Codex auth")
    .option("--codex-auth-path <path>", "Codex auth.json path")
    .option("--fixture <path>", "Fixture directory override")
    .option("--keep-artifacts", "Keep temporary compile output")
    .option("--node-command <command>", "Node command", "node")
    .option("--npm-command <command>", "npm command", "npm")
    .option("--out <path>", "Compile output directory");

  await command.parseAsync(argv, { from: "user" });
  const options = command.opts<{
    codexAuthPath?: string;
    fixture?: string;
    keepArtifacts?: boolean;
    nodeCommand?: string;
    npmCommand?: string;
    out?: string;
  }>();
  const result = await runDaimonOrgE2E({
    codexAuthPath: options.codexAuthPath,
    fixtureDirectory: options.fixture,
    keepArtifacts: options.keepArtifacts,
    nodeCommand: options.nodeCommand,
    npmCommand: options.npmCommand,
    outputDirectory: options.out
  });
  console.log(
    `Legacy Pi org E2E passed (${result.mapperNotePath}, ${result.reviewerNotePath}; ` +
    `memory_events=${result.memoryEventCount} recalled=${result.memoryRecallCount})`
  );
};
