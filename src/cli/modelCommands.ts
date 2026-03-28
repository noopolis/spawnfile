import { Command } from "commander";

import type { CliHandlers, CliStreams } from "./runCli.js";

export const registerModelCommands = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  const modelCommand = program
    .command("model")
    .description("Edit primary and fallback model declarations");

  modelCommand
    .command("set")
    .argument("<provider>", "Model provider")
    .argument("<name>", "Model name")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--auth <method>", "Model auth method")
    .option("--key <env>", "Environment variable for api_key auth")
    .option("--compat <compatibility>", "Endpoint compatibility for custom/local models")
    .option("--base-url <url>", "Endpoint base URL for custom/local models")
    .option("--recursive", "Update the target project and its descendants")
    .action(
      async (
        provider: string,
        name: string,
        inputPath: string,
        options: {
          auth?: "api_key" | "claude-code" | "codex" | "none";
          baseUrl?: string;
          compat?: "anthropic" | "openai";
          key?: string;
          recursive?: boolean;
        }
      ) => {
        const result = await handlers.setProjectPrimaryModel({
          authKey: options.key,
          authMethod: options.auth,
          endpointBaseUrl: options.baseUrl,
          endpointCompatibility: options.compat,
          name,
          path: inputPath,
          provider,
          recursive: options.recursive
        });

        for (const filePath of result.updatedFiles) {
          streams.stdout(`updated ${filePath}`);
        }
      }
    );

  modelCommand
    .command("add-fallback")
    .argument("<provider>", "Model provider")
    .argument("<name>", "Model name")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--auth <method>", "Model auth method")
    .option("--key <env>", "Environment variable for api_key auth")
    .option("--compat <compatibility>", "Endpoint compatibility for custom/local models")
    .option("--base-url <url>", "Endpoint base URL for custom/local models")
    .option("--recursive", "Update the target project and its descendants")
    .action(
      async (
        provider: string,
        name: string,
        inputPath: string,
        options: {
          auth?: "api_key" | "claude-code" | "codex" | "none";
          baseUrl?: string;
          compat?: "anthropic" | "openai";
          key?: string;
          recursive?: boolean;
        }
      ) => {
        const result = await handlers.addProjectModelFallback({
          authKey: options.key,
          authMethod: options.auth,
          endpointBaseUrl: options.baseUrl,
          endpointCompatibility: options.compat,
          name,
          path: inputPath,
          provider,
          recursive: options.recursive
        });

        for (const filePath of result.updatedFiles) {
          streams.stdout(`updated ${filePath}`);
        }
      }
    );

  modelCommand
    .command("clear-fallbacks")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .option("--recursive", "Update the target project and its descendants")
    .action(async (inputPath: string, options: { recursive?: boolean }) => {
      const result = await handlers.clearProjectModelFallbacks({
        path: inputPath,
        recursive: options.recursive
      });

      for (const filePath of result.updatedFiles) {
        streams.stdout(`updated ${filePath}`);
      }
    });
};
