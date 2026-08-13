import type { Command } from "commander";

import { SpawnfileError } from "../shared/index.js";

import { resolveCommandInput } from "./resolveCommandInput.js";
import type { CliHandlers, CliStreams } from "./runCli.js";

export const registerRunPublishCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  program
    .command("run")
    .description("Compile, build, and run the organization container locally")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .option("--auth-profile <name>", "Local Spawnfile auth profile")
    .option("--context <name>", "Docker context for the deployment target")
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("--name <container>", "Docker container name")
    .option("--env-file <file>", "Path to an env file for runtime secrets")
    .option("--world-bindings <file>", "Path to a versioned world-bindings artifact")
    .option("--image", "Interpret the argument as an image reference")
    .option("-d, --detach", "Run the container in detached mode")
    .action(async (
      inputPath: string,
      options: {
        authProfile?: string;
        context?: string;
        detach?: boolean;
        deployment?: string;
        dockerCommand?: string;
        envFile?: string;
        image?: boolean;
        name?: string;
        out?: string;
        tag?: string;
        worldBindings?: string;
      }
    ) => {
      const runInput = resolveCommandInput(inputPath, { forceImage: options.image });
      if (runInput.kind === "image" || (runInput.kind === "invalid" && options.image)) {
        throw new SpawnfileError(
          "validation_error",
          `Image-mode run is not supported. Deploy the image with: ` +
            `spawnfile up ${inputPath} --auth-profile <profile> ` +
            "(add --env-file for any extra secrets; image deployments always detach)."
        );
      }
      if (runInput.kind === "invalid") {
        throw new SpawnfileError(
          "validation_error",
          `Cannot resolve "${inputPath}" as a project path or image reference. ` +
            "Pass a project directory, a Spawnfile path, or an image like 'name:tag' (use --image to force image mode)."
        );
      }
      const result = await handlers.runProject(inputPath, {
        authProfile: options.authProfile,
        containerName: options.name,
        detach: options.detach,
        deploymentName: options.deployment,
        dockerCommand: options.dockerCommand,
        dockerContext: options.context,
        envFilePath: options.envFile,
        imageTag: options.tag,
        outputDirectory: options.out,
        ...(options.worldBindings !== undefined
          ? { worldBindingsPath: options.worldBindings }
          : {})
      });

      if (options.detach) {
        streams.stdout(`running container ${result.containerName ?? "unknown"}`);
        streams.stdout(`image: ${result.imageTag}`);
      }
    });

  program
    .command("publish")
    .description("Compile, build, verify, and push the organization image to a registry")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .requiredOption("-t, --tag <image>", "Registry image reference to push")
    .option("-o, --out <directory>", "Output directory")
    .option("--docker-command <command>", "Docker command")
    .action(async (
      inputPath: string,
      options: { dockerCommand?: string; out?: string; tag?: string }
    ) => {
      const publishInput = resolveCommandInput(inputPath);
      if (publishInput.kind !== "project") {
        throw new SpawnfileError(
          "validation_error",
          "publish operates on a project path, not an image reference"
        );
      }
      const result = await handlers.publishProject(inputPath, {
        dockerCommand: options.dockerCommand,
        imageTag: options.tag,
        outputDirectory: options.out
      });
      streams.stdout(`published ${result.imageTag}`);
      streams.stdout(`digest: ${result.digest ?? "unknown"}`);
      streams.stdout(`next: spawnfile up ${result.imageTag} --detach --auth-profile <profile>`);
    });
};
