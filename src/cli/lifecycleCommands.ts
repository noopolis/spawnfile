import type { Command } from "commander";

import { consumeImageUp } from "../distribution/index.js";
import { readRunEnvFile } from "../compiler/runProjectAuth.js";
import { SpawnfileError } from "../shared/index.js";

import { resolveCommandInput } from "./resolveCommandInput.js";
import type { CliHandlers, CliStreams } from "./runCli.js";

const resolveAuthProfileForImage = async (
  handlers: CliHandlers,
  authProfile: string | undefined
): Promise<Awaited<ReturnType<CliHandlers["requireAuthProfile"]>> | null> => {
  if (!authProfile || !handlers.requireAuthProfile) {
    return null;
  }
  return handlers.requireAuthProfile(authProfile);
};

export const registerLifecycleCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  program
    .command("compile")
    .description("Compile a project into runtime-native output under .spawn")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .action(async (inputPath: string, options: { out?: string }) => {
      const result = await handlers.compileProject(inputPath, { outputDirectory: options.out });
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
    });

  program
    .command("build")
    .description("Compile and build the organization Docker image")
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
    .option("--image", "Interpret the argument as an image reference")
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
          image?: boolean;
          name?: string;
          out?: string;
          tag?: string;
        }
      ) => {
        const runInput = resolveCommandInput(inputPath, { forceImage: options.image });
        if (runInput.kind === "image" || (runInput.kind === "invalid" && options.image)) {
          throw new SpawnfileError(
            "validation_error",
            `Image-mode run is not supported. Use: spawnfile up ${inputPath} --detach`
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
          outputDirectory: options.out
        });

        if (options.detach) {
          streams.stdout(`running container ${result.containerName ?? "unknown"}`);
          streams.stdout(`image: ${result.imageTag}`);
        }
      }
    );

  program
    .command("publish")
    .description("Compile, build, verify, and push the organization image to a registry")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .requiredOption("-t, --tag <image>", "Registry image reference to push")
    .option("-o, --out <directory>", "Output directory")
    .option("--docker-command <command>", "Docker command")
    .action(
      async (
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
      }
    );

  program
    .command("up")
    .description("Deploy an organization from a project or a published image reference")
    .argument("[path]", "Project directory, Spawnfile path, or image reference", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .option("--auth-profile <name>", "Local Spawnfile auth profile")
    .option("--context <name>", "Docker context for the deployment target")
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("--name <container>", "Docker container name")
    .option("--env-file <file>", "Path to an env file for runtime secrets")
    .option("--image", "Interpret the argument as an image reference")
    .option("--pull", "Pull the image before deploying")
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
          image?: boolean;
          name?: string;
          out?: string;
          pull?: boolean;
          tag?: string;
        }
      ) => {
        const upInput = resolveCommandInput(inputPath, { forceImage: options.image });
        if (upInput.kind === "invalid") {
          throw new SpawnfileError(
            "validation_error",
            `Cannot resolve "${inputPath}" as a project path or image reference. ` +
              "Pass a project directory, a Spawnfile path, or an image like 'name:tag' (use --image to force image mode)."
          );
        }

        /* v8 ignore start -- sourceless image up is covered by distribution E2E */
        if (upInput.kind === "image") {
          const [authProfile, envFileEnv] = await Promise.all([
            resolveAuthProfileForImage(handlers, options.authProfile),
            readRunEnvFile(options.envFile)
          ]);
          const consumed = await consumeImageUp(upInput.ref, {
            authProfile,
            authProfileName: options.authProfile ?? null,
            authValues: authProfile?.env ?? {},
            deploymentName: options.deployment,
            dockerCommand: options.dockerCommand,
            dockerContext: options.context,
            envFileEnv,
            envFilePath: options.envFile ?? null,
            pull: options.pull
          });
          streams.stdout(`deployed image ${consumed.imageRef}`);
          streams.stdout(`deployment: ${consumed.deploymentName}`);
          streams.stdout(`running container ${consumed.containerName}`);
          streams.stdout(`record: ${consumed.recordPath}`);
          return;
        }
        /* v8 ignore stop */

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
