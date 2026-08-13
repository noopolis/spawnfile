import type { Command } from "commander";

import type { CliHandlers, CliStreams } from "./runCli.js";

export const registerCompileBuildCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  program
    .command("compile")
    .description("Compile a project into runtime-native output under .spawn")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("--world-bindings <file>", "Path to a versioned world-bindings artifact")
    .action(async (
      inputPath: string,
      options: { out?: string; worldBindings?: string }
    ) => {
      const result = await handlers.compileProject(inputPath, {
        outputDirectory: options.out,
        worldBindingsPath: options.worldBindings
      });
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("build")
    .description("Compile and build the organization Docker image")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--context <name>", "Docker context for the build target")
    .option("--docker-command <command>", "Docker command")
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .action(async (
      inputPath: string,
      options: { context?: string; dockerCommand?: string; out?: string; tag?: string }
    ) => {
      const result = await handlers.buildProject(inputPath, {
        dockerContext: options.context,
        dockerCommand: options.dockerCommand,
        imageTag: options.tag,
        outputDirectory: options.out
      });
      streams.stdout(`built image ${result.imageTag}`);
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });
};
