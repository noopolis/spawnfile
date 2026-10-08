import type { Command } from "commander";

import { describeBackedMountRequirement } from "../compiler/containerBackedMountRender.js";
import type { CompileReport } from "../report/index.js";

import type { CliHandlers, CliStreams } from "./runCli.js";

/**
 * Durable mounts are only attached by `spawnfile run`/`up`/`deploy`. A
 * hand-rolled `docker run` of the built image gets none of them and the
 * entrypoint now refuses to start, so say up front how many the launcher owes.
 */
const reportDurableMounts = (report: CompileReport, streams: CliStreams): void => {
  const line = describeBackedMountRequirement(report.container?.persistent_mounts ?? []);
  if (line) streams.stdout(line);
};

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
    .option("--release", "Build workspace bundles only from clean committed inputs")
    .action(async (
      inputPath: string,
      options: { out?: string; release?: boolean; worldBindings?: string }
    ) => {
      const result = await handlers.compileProject(inputPath, {
        ...(options.release ? { bundleIdentity: "release" as const } : {}),
        outputDirectory: options.out,
        worldBindingsPath: options.worldBindings
      });
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
      reportDurableMounts(result.report, streams);
    });

  program
    .command("build")
    .description("Compile and build the organization Docker image")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--context <name>", "Docker context for the build target")
    .option("--docker-command <command>", "Docker command")
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .option("--release", "Build workspace bundles only from clean committed inputs")
    .action(async (
      inputPath: string,
      options: { context?: string; dockerCommand?: string; out?: string; release?: boolean; tag?: string }
    ) => {
      const result = await handlers.buildProject(inputPath, {
        ...(options.release ? { bundleIdentity: "release" as const } : {}),
        dockerContext: options.context,
        dockerCommand: options.dockerCommand,
        imageTag: options.tag,
        outputDirectory: options.out
      });
      streams.stdout(`built image ${result.imageTag}`);
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
      reportDurableMounts(result.report, streams);
    });
};
