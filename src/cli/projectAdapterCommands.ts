import type { Command } from "commander";

import { getManifestPath } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import { resolveCommandInput } from "./resolveCommandInput.js";
import type { CliStreams } from "./runCli.js";

/**
 * Commands whose `[path]` operand selects a source project. Only these load the adapters that
 * project's root Spawnfile declares, and only from the operand the operator typed (or its cwd
 * default), never from a path recorded in a report or saved artifact.
 */
export const PROJECT_ADAPTER_COMMANDS: ReadonlySet<string> = new Set([
  "add agent", "add subagent", "add team", "artifacts export", "auth sync", "build", "compile",
  "dev stop", "dev up", "down", "model add-fallback", "model clear-fallbacks", "model set",
  "publish", "record sync", "release", "run", "runtime set", "status", "surface add",
  "surface remove", "surface set-access", "surface show", "train", "up", "usage", "validate",
  "view", "volume refresh", "volume verify"
]);

export const commandPath = (command: Command): string => {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names.join(" ");
};

/** Commands whose positional operand may name an image instead of a project. */
const IMAGE_CAPABLE_COMMANDS: ReadonlySet<string> = new Set(["run", "status", "up"]);

/**
 * The project path a parsed project command operates on, or undefined when the parsed
 * invocation does not read a source project. Mirrors each handler's own mode routing:
 * an image operand (forced with --image or implicit) for up, run and status; the home-only
 * `status --deployment` without --context on the default path; and saved-output-only
 * `train --regrade`. A missing optional path defaults to the process cwd, as the handlers do.
 */
export const projectAdapterOperand = (command: Command): string | undefined => {
  const name = commandPath(command);
  if (!PROJECT_ADAPTER_COMMANDS.has(name)) return undefined;
  const index = command.registeredArguments.findIndex((argument) => argument.name() === "path");
  if (index < 0) return undefined;
  const raw: unknown = command.processedArgs[index];
  if (raw !== undefined && typeof raw !== "string") return undefined;
  const value = raw ?? process.cwd();
  const options = command.opts<{ context?: unknown; deployment?: unknown; image?: boolean; regrade?: unknown }>();
  const input = IMAGE_CAPABLE_COMMANDS.has(name) ? resolveCommandInput(value, { forceImage: options.image }) : undefined;
  if (input !== undefined && input.kind !== "project") return undefined;
  if (name === "status" && options.deployment && !options.context && value === process.cwd()) return undefined;
  if (name === "train" && typeof options.regrade === "string") return undefined;
  return value;
};

/** Adds trusted root-declared adapters to the invocation scope before a project command acts. */
export const registerProjectAdapterHook = (program: Command): void => {
  program.hook("preAction", async (_program, action) => {
    const operand = projectAdapterOperand(action);
    if (operand === undefined) return;
    const { loadDeclaredRuntimeAdapters, readDeclaredProjectAdapters } = await import("../projectAdapters/index.js");
    const declared = await readDeclaredProjectAdapters(operand);
    if (!declared) return;
    const { addRuntimeAdapterPlugins, getScopedRuntimeAdapter } = await import("../runtime/registry.js");
    // An explicit --adapter for the same runtime id wins; its declared module is not imported.
    const provided = new Set(declared.adapters.map(([name]) => name).filter((name) => getScopedRuntimeAdapter(name)));
    await addRuntimeAdapterPlugins(await loadDeclaredRuntimeAdapters(declared, { provided }));
  });
};

export const registerAdaptersCommands = (program: Command, streams: CliStreams): void => {
  program
    .command("adapters")
    .description("Manage runtime adapters declared by project Spawnfiles")
    .command("trust")
    .description("Approve the adapter modules a root Spawnfile declares, as data, without loading them")
    .argument("[path]", "Project directory or Spawnfile path", process.cwd())
    .action(async (inputPath: string) => {
      const { readDeclaredProjectAdapters, trustProjectAdapterSet } = await import("../projectAdapters/index.js");
      const declared = await readDeclaredProjectAdapters(inputPath);
      if (!declared) {
        throw new SpawnfileError("validation_error", `No adapters are declared by ${getManifestPath(inputPath)}`);
      }
      const store = await trustProjectAdapterSet(declared);
      streams.stdout(`trusted ${declared.manifestPath}`);
      for (const [name, specifier] of declared.adapters) streams.stdout(`adapter ${name} ${specifier}`);
      streams.stdout(`recorded ${store}`);
      streams.stdout("approval covers these exact declarations; module contents and dependencies are not pinned");
    });
};
