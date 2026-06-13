import { Command } from "commander";

import type { CliHandlers, CliStreams } from "./runCli.js";

export const registerRuntimeCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  const runtimeCommand = program
    .command("runtime")
    .description("Edit runtime declarations");

  runtimeCommand
    .command("set")
    .description("Set an agent's runtime binding")
    .argument("<name>", "Runtime name")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--recursive", "Update the target project and its descendants")
    .action(
      async (
        runtime: string,
        inputPath: string,
        options: { recursive?: boolean }
      ) => {
        const result = await handlers.setProjectRuntime({
          path: inputPath,
          recursive: options.recursive,
          runtime
        });

        for (const filePath of result.updatedFiles) {
          streams.stdout(`updated ${filePath}`);
        }
      }
    );
};

