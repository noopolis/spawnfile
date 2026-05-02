import { stat } from "node:fs/promises";
import path from "node:path";

import { Command, Option } from "commander";

import {
  renderOrganizationNetworks,
  renderOrganizationTree,
  type RenderOrganizationViewOptions
} from "../compiler/index.js";
import { SpawnfileError } from "../shared/index.js";

import type { CliHandlers, CliRenderEnvironment, CliStreams } from "./runCli.js";

const VIEW_MODES = ["tree", "networks"] as const;
const VIEW_SHOW_OPTIONS = ["paths", "declared"] as const;
const VIEW_COLOR_OPTIONS = ["auto", "always", "never"] as const;

type ViewMode = (typeof VIEW_MODES)[number];
type ViewShow = (typeof VIEW_SHOW_OPTIONS)[number];
type ViewColor = (typeof VIEW_COLOR_OPTIONS)[number];

interface ViewCommandOptions {
  ascii?: boolean;
  color: ViewColor;
  mode: ViewMode;
  paths?: boolean;
  show?: string;
}

const isViewMode = (value: string): value is ViewMode =>
  VIEW_MODES.includes(value as ViewMode);

const isViewShow = (value: string): value is ViewShow =>
  VIEW_SHOW_OPTIONS.includes(value as ViewShow);

const manifestPathFor = (inputPath: string): string =>
  path.basename(inputPath) === "Spawnfile"
    ? path.resolve(inputPath)
    : path.resolve(inputPath, "Spawnfile");

const hasResolvedSpawnfile = async (inputPath: string): Promise<boolean> => {
  try {
    return (await stat(manifestPathFor(inputPath))).isFile();
  } catch {
    return false;
  }
};

const suggestModeOptionForPathToken = async (inputPath?: string): Promise<void> => {
  if (!inputPath || !isViewMode(inputPath) || await hasResolvedSpawnfile(inputPath)) {
    return;
  }

  throw new SpawnfileError(
    "validation_error",
    `No Spawnfile found for path "${inputPath}". Did you mean "spawnfile view --mode ${inputPath}"?`
  );
};

const resolveColor = (
  color: ViewColor,
  environment: CliRenderEnvironment
): boolean => {
  if (color === "always") {
    return true;
  }

  if (color === "never") {
    return false;
  }

  return environment.stdoutIsTty && !environment.ci && !environment.noColor;
};

const parseShowLayers = (value?: string): Set<ViewShow> => {
  const layers = new Set<ViewShow>();
  if (!value) {
    return layers;
  }

  for (const layer of value.split(",")) {
    const normalized = layer.trim();
    if (!isViewShow(normalized)) {
      throw new SpawnfileError(
        "validation_error",
        `Unsupported view detail layer "${normalized}". Supported layers: paths, declared.`
      );
    }
    layers.add(normalized);
  }

  return layers;
};

const toRenderOptions = (
  options: ViewCommandOptions,
  environment: CliRenderEnvironment
): RenderOrganizationViewOptions => {
  const showLayers = parseShowLayers(options.show);
  if (options.paths) {
    showLayers.add("paths");
  }

  return {
    ascii: options.ascii,
    color: resolveColor(options.color, environment),
    declared: showLayers.has("declared"),
    paths: showLayers.has("paths")
  };
};

const emitRenderedView = (streams: CliStreams, output: string): void => {
  for (const line of output.split("\n")) {
    streams.stdout(line);
  }
};

export const registerViewCommand = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams,
  renderEnvironment: CliRenderEnvironment
): void => {
  program
    .command("view")
    .description("Render a read-only organization view")
    .argument("[path]", "Project directory or Spawnfile path")
    .addOption(new Option("--mode <mode>", "View mode").choices(VIEW_MODES).default("tree"))
    .option("--show <show>", "Comma-separated additional details")
    .option("--ascii", "Use ASCII tree connectors")
    .addOption(new Option("--color <when>", "Color output").choices(VIEW_COLOR_OPTIONS).default("auto"))
    .option("--paths", "Show source paths")
    .action(async (inputPath: string | undefined, options: ViewCommandOptions) => {
      await suggestModeOptionForPathToken(inputPath);
      const renderOptions = toRenderOptions(options, renderEnvironment);

      const view = await handlers.buildOrganizationView(inputPath ?? process.cwd());
      const output = options.mode === "networks"
        ? renderOrganizationNetworks(view, renderOptions)
        : renderOrganizationTree(view, renderOptions);

      emitRenderedView(streams, output);
    });
};
