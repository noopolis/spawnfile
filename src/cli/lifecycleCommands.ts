import type { Command } from "commander";

import type { CliHandlers, CliStreams } from "./runCli.js";

export const registerLifecycleCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  program
    .command("compile")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .action(async (inputPath: string, options: { out?: string }) => {
      const result = await handlers.compileProject(inputPath, { outputDirectory: options.out });
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("build")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--docker-command <command>", "Docker command")
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .action(async (inputPath: string, options: { dockerCommand?: string; out?: string; tag?: string }) => {
      const result = await handlers.buildProject(inputPath, {
        dockerCommand: options.dockerCommand,
        imageTag: options.tag,
        outputDirectory: options.out
      });
      streams.stdout(`built image ${result.imageTag}`);
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("run")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .option("--auth-profile <name>", "Local Spawnfile auth profile")
    .option("--context <name>", "Docker context for the deployment target")
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("--name <container>", "Docker container name")
    .option("--env-file <file>", "Path to an env file for runtime secrets")
    .option("-d, --detach", "Run the container in detached mode")
    .action(
      async (
        inputPath: string,
        options: {
          authProfile?: string;
          context?: string;
          detach?: boolean;
          deployment?: string;
          dockerCommand?: string;
          envFile?: string;
          name?: string;
          out?: string;
          tag?: string;
        }
      ) => {
        const result = await handlers.runProject(inputPath, {
          authProfile: options.authProfile,
          containerName: options.name,
          detach: options.detach,
          deploymentName: options.deployment,
          dockerCommand: options.dockerCommand,
          dockerContext: options.context,
          envFilePath: options.envFile,
          imageTag: options.tag,
          outputDirectory: options.out
        });

        if (options.detach) {
          streams.stdout(`running container ${result.containerName ?? "unknown"}`);
          streams.stdout(`image: ${result.imageTag}`);
        }
      }
    );

  program
    .command("up")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .option("--auth-profile <name>", "Local Spawnfile auth profile")
    .option("--context <name>", "Docker context for the deployment target")
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("--name <container>", "Docker container name")
    .option("--env-file <file>", "Path to an env file for runtime secrets")
    .option("-d, --detach", "Run the container in detached mode")
    .action(
      async (
        inputPath: string,
        options: {
          authProfile?: string;
          context?: string;
          detach?: boolean;
          deployment?: string;
          dockerCommand?: string;
          envFile?: string;
          name?: string;
          out?: string;
          tag?: string;
        }
      ) => {
        const result = await handlers.upProject(inputPath, {
          authProfile: options.authProfile,
          containerName: options.name,
          detach: options.detach,
          deploymentName: options.deployment,
          dockerCommand: options.dockerCommand,
          dockerContext: options.context,
          envFilePath: options.envFile,
          imageTag: options.tag,
          outputDirectory: options.out
        });

        streams.stdout(`built image ${result.imageTag}`);
        streams.stdout(`compiled to ${result.outputDirectory}`);
        streams.stdout(`report: ${result.reportPath}`);
        if (options.detach) {
          streams.stdout(`running container ${result.containerName ?? "unknown"}`);
          streams.stdout(`image: ${result.imageTag}`);
        }
      }
    );
};
