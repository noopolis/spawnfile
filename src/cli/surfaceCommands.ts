import { Command } from "commander";
import YAML from "yaml";

import type { SurfaceName } from "../compiler/index.js";

import type { CliHandlers, CliStreams } from "./runCli.js";

const collectStringOption = (value: string, previous: string[]): string[] => [...previous, value];

const emitSurfaceSummaries = (
  streams: CliStreams,
  entries: Awaited<ReturnType<CliHandlers["showProjectSurfaces"]>>["entries"]
): void => {
  entries.forEach((entry, index) => {
    if (index > 0) {
      streams.stdout("");
    }

    streams.stdout(`path: ${entry.manifestPath}`);
    streams.stdout(`kind: ${entry.kind}`);
    streams.stdout(`name: ${entry.name}`);
    if (!entry.surfaces) {
      streams.stdout("surfaces: none");
      return;
    }

    streams.stdout(YAML.stringify({ surfaces: entry.surfaces }).trimEnd());
  });
};

export const registerSurfaceCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  const surfaceCommand = program
    .command("surface")
    .description("Edit agent surfaces");

  surfaceCommand
    .command("add")
    .argument("<surface>", "Surface name")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--bot-token-secret <env>", "Override the bot token env var name")
    .option("--app-token-secret <env>", "Override the Slack app token env var name")
    .option("--recursive", "Update the target project and its descendants")
    .action(
      async (
        surface: SurfaceName,
        inputPath: string,
        options: {
          appTokenSecret?: string;
          botTokenSecret?: string;
          recursive?: boolean;
        }
      ) => {
        const result = await handlers.addProjectSurface({
          appTokenSecret: options.appTokenSecret,
          botTokenSecret: options.botTokenSecret,
          path: inputPath,
          recursive: options.recursive,
          surface
        });

        for (const filePath of result.updatedFiles) {
          streams.stdout(`updated ${filePath}`);
        }
      }
    );

  surfaceCommand
    .command("remove")
    .argument("<surface>", "Surface name")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--recursive", "Update the target project and its descendants")
    .action(async (surface: SurfaceName, inputPath: string, options: { recursive?: boolean }) => {
      const result = await handlers.removeProjectSurface({
        path: inputPath,
        recursive: options.recursive,
        surface
      });

      for (const filePath of result.updatedFiles) {
        streams.stdout(`updated ${filePath}`);
      }
    });

  surfaceCommand
    .command("set-access")
    .argument("<surface>", "Surface name")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .requiredOption("--mode <mode>", "Access mode")
    .option("--user <id>", "Allowlisted user id", collectStringOption, [])
    .option("--channel <id>", "Allowlisted channel id", collectStringOption, [])
    .option("--guild <id>", "Allowlisted guild id", collectStringOption, [])
    .option("--chat <id>", "Allowlisted chat id", collectStringOption, [])
    .option("--group <id>", "Allowlisted group id", collectStringOption, [])
    .option("--recursive", "Update the target project and its descendants")
    .action(
      async (
        surface: SurfaceName,
        inputPath: string,
        options: {
          channel: string[];
          chat: string[];
          group: string[];
          guild: string[];
          mode: "allowlist" | "open" | "pairing";
          recursive?: boolean;
          user: string[];
        }
      ) => {
        const result = await handlers.setProjectSurfaceAccess({
          channels: options.channel,
          chats: options.chat,
          groups: options.group,
          guilds: options.guild,
          mode: options.mode,
          path: inputPath,
          recursive: options.recursive,
          surface,
          users: options.user
        });

        for (const filePath of result.updatedFiles) {
          streams.stdout(`updated ${filePath}`);
        }
      }
    );

  surfaceCommand
    .command("show")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--recursive", "Show descendant agent surfaces too")
    .action(async (inputPath: string, options: { recursive?: boolean }) => {
      const result = await handlers.showProjectSurfaces({
        path: inputPath,
        recursive: options.recursive
      });
      emitSurfaceSummaries(streams, result.entries);
    });
};
