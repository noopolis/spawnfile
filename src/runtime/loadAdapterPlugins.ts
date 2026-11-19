import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "import-meta-resolve";

import { SpawnfileError } from "../shared/index.js";
import { type RuntimeAdapterPlugin, validateRuntimeAdapterPlugin } from "./pluginDefinition.js";

const pathSpecifier = /^(?:\.\.?[\\/]|file:)/u;
const packageSpecifier = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/u;

const resolveModule = (specifier: string, cwd: string): string => {
  if (path.isAbsolute(specifier) || pathSpecifier.test(specifier)) {
    const filename = specifier.startsWith("file:") ? fileURLToPath(specifier) : path.resolve(cwd, specifier);
    return pathToFileURL(filename).href;
  }
  if (!packageSpecifier.test(specifier)) throw new Error("expected a local file path or installed package name");
  const url = resolve(specifier, pathToFileURL(path.join(cwd, "package.json")).href);
  if (!url.startsWith("file:")) throw new Error("adapter must resolve to a local ESM module");
  return url;
};

export const loadRuntimeAdapterPlugins = async (
  specifiers: readonly string[],
  { cwd = process.cwd() }: { cwd?: string } = {}
): Promise<RuntimeAdapterPlugin[]> => {
  const plugins: RuntimeAdapterPlugin[] = [];
  for (const specifier of specifiers) {
    let exported: unknown;
    try {
      const url = resolveModule(specifier, path.resolve(cwd));
      const module: { spawnfileAdapter?: unknown } = await import(/* @vite-ignore */ url);
      exported = module.spawnfileAdapter;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SpawnfileError("validation_error", `Unable to load adapter ${JSON.stringify(specifier)} from ${cwd}: ${detail}`);
    }
    plugins.push(validateRuntimeAdapterPlugin(exported, JSON.stringify(specifier)));
  }
  return plugins;
};
