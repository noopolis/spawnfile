import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "import-meta-resolve";

import { SpawnfileError } from "../shared/index.js";
import { withRuntimeAdapterPlugins } from "./registry.js";
import { type RuntimeAdapterPlugin, validateRuntimeAdapterPlugin } from "./pluginDefinition.js";

const pathSpecifier = /^(?:\.\.?[\\/]|file:)/u;
const packageSpecifier = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/u;

/** Resolves an installed package from `directory`, refusing anything but a local file module. */
export const resolveInstalledAdapterPackage = (specifier: string, directory: string): string => {
  if (!packageSpecifier.test(specifier)) throw new Error("expected a local file path or installed package name");
  const url = resolve(specifier, pathToFileURL(path.join(directory, "package.json")).href);
  if (!url.startsWith("file:")) throw new Error("adapter must resolve to a local ESM module");
  return url;
};

const resolveModule = (specifier: string, cwd: string): string => {
  if (path.isAbsolute(specifier) || pathSpecifier.test(specifier)) {
    const filename = specifier.startsWith("file:") ? fileURLToPath(specifier) : path.resolve(cwd, specifier);
    return pathToFileURL(filename).href;
  }
  return resolveInstalledAdapterPackage(specifier, cwd);
};

export interface AdapterModuleRequest {
  /** Resolves the module URL; called before any module in the batch is imported. */
  resolveUrl: () => string | Promise<string>;
  specifier: string;
}

const describeFailure = (specifier: string, origin: string, error: unknown): SpawnfileError =>
  new SpawnfileError(
    "validation_error",
    `Unable to load adapter ${JSON.stringify(specifier)} from ${origin}: ${error instanceof Error ? error.message : String(error)}`
  );

/**
 * Resolves every request first, then imports in order. Module initialization sees only the
 * bundled catalog, even when called inside another invocation's scope.
 */
export const importRuntimeAdapterModules = (
  requests: readonly AdapterModuleRequest[], origin: string
): Promise<RuntimeAdapterPlugin[]> => withRuntimeAdapterPlugins([], async () => {
  const urls: string[] = [];
  for (const { resolveUrl, specifier } of requests) {
    try {
      urls.push(await resolveUrl());
    } catch (error) {
      throw describeFailure(specifier, origin, error);
    }
  }
  const plugins: RuntimeAdapterPlugin[] = [];
  for (const [index, { specifier }] of requests.entries()) {
    let exported: unknown;
    try {
      const module: { spawnfileAdapter?: unknown } = await import(/* @vite-ignore */ urls[index]!);
      exported = module.spawnfileAdapter;
    } catch (error) {
      throw describeFailure(specifier, origin, error);
    }
    plugins.push(validateRuntimeAdapterPlugin(exported, JSON.stringify(specifier)));
  }
  return plugins;
});

export const loadRuntimeAdapterPlugins = (
  specifiers: readonly string[], { cwd = process.cwd() }: { cwd?: string } = {}
): Promise<RuntimeAdapterPlugin[]> => {
  const directory = path.resolve(cwd);
  return importRuntimeAdapterModules(
    specifiers.map((specifier) => ({ resolveUrl: () => resolveModule(specifier, directory), specifier })),
    cwd
  );
};
