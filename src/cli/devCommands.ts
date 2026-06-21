import type { Command } from "commander";

import type { CliHandlers, CliStreams } from "./runCli.js";

export const registerDevCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  const dev = program.command("dev").description("Run an interactive Spawnfile development deployment");

  dev
    .command("up")
    .description("Compile, build, and start a detached dev deployment under .spawn-dev")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--auth-profile <name>", "Local Spawnfile auth profile")
    .option("--context <name>", "Docker context for the deployment target")
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("--env-file <file>", "Path to an env file for runtime secrets")
    .option("--name <container>", "Docker container name")
    .option("-o, --out <directory>", "Dev output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .action(async (
      inputPath: string,
      options: {
        authProfile?: string;
        context?: string;
        deployment?: string;
        dockerCommand?: string;
        envFile?: string;
        name?: string;
        out?: string;
        tag?: string;
      }
    ) => {
      const result = await handlers.devUpProject(inputPath, {
        authProfile: options.authProfile,
        containerName: options.name,
        deploymentName: options.deployment,
        dockerCommand: options.dockerCommand,
        dockerContext: options.context,
        envFilePath: options.envFile,
        imageTag: options.tag,
        outputDirectory: options.out
      });
      streams.stdout(`dev deployment: ${result.containerName ?? "unknown"}`);
      streams.stdout(`image: ${result.imageTag}`);
      streams.stdout(`compiled to ${result.outputDirectory}`);
      if (result.deploymentRecordPath) {
        streams.stdout(`record: ${result.deploymentRecordPath}`);
      }
    });

  dev
    .command("apply")
    .description("Hot-apply one agent into a running dev deployment")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .requiredOption("--agent <id>", "Agent id, slug, or name to hot-apply")
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("-o, --out <directory>", "Dev output directory")
    .action(async (
      inputPath: string,
      options: { agent: string; deployment?: string; dockerCommand?: string; out?: string }
    ) => {
      const result = await handlers.devApplyProject(inputPath, {
        agent: options.agent,
        deploymentName: options.deployment,
        dockerCommand: options.dockerCommand,
        outputDirectory: options.out
      });
      streams.stdout(`applied agent ${result.agentId}`);
      streams.stdout(`container: ${result.containerName}`);
      streams.stdout(`bridge: ${result.bridgeStarted ? "started" : "unchanged"}`);
    });

  dev
    .command("restart")
    .description("Reload one agent in a running dev deployment")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .requiredOption("--agent <id>", "Agent id, slug, or name to reload")
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("-o, --out <directory>", "Dev output directory")
    .action(async (
      inputPath: string,
      options: { agent: string; deployment?: string; dockerCommand?: string; out?: string }
    ) => {
      const result = await handlers.devRestartProject(inputPath, {
        agent: options.agent,
        deploymentName: options.deployment,
        dockerCommand: options.dockerCommand,
        outputDirectory: options.out
      });
      streams.stdout(`restarted agent ${result.agentId}`);
      streams.stdout(`container: ${result.containerName}`);
      streams.stdout(`bridge: ${result.bridgeStarted ? "started" : "unchanged"}`);
    });

  dev
    .command("stop")
    .description("Stop the recorded dev deployment container")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("-o, --out <directory>", "Dev output directory")
    .action(async (
      inputPath: string,
      options: { deployment?: string; dockerCommand?: string; out?: string }
    ) => {
      const result = await handlers.devStopProject(inputPath, {
        deploymentName: options.deployment,
        dockerCommand: options.dockerCommand,
        outputDirectory: options.out
      });
      streams.stdout(`stopped dev deployment ${result.deploymentName}`);
      streams.stdout(`container: ${result.containerName}`);
    });
};
