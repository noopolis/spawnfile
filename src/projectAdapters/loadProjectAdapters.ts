import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isLocalAdapterSpecifier } from "../manifest/adapterSchemas.js";
import {
  importRuntimeAdapterModules,
  resolveInstalledAdapterPackage
} from "../runtime/loadAdapterPlugins.js";
import type { RuntimeAdapterPlugin } from "../runtime/pluginDefinition.js";
import { isBundledRuntimeAdapter } from "../runtime/registry.js";
import { SpawnfileError } from "../shared/index.js";
import { type DeclaredProjectAdapters, readDeclaredProjectAdapters } from "./declarations.js";

export interface LoadProjectAdaptersOptions {
  /** Runtime ids already supplied explicitly (for example by `--adapter`); their declarations are not imported. */
  provided?: ReadonlySet<string>;
}

/** Component-aware containment: `..plugins/x` is inside the parent; only `..` itself or `../x` escapes. */
const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** `./` modules must stay inside the project after every symlink is resolved. */
const resolveLocalModule = async (projectRoot: string, specifier: string): Promise<string> => {
  const target = await realpath(path.resolve(projectRoot, specifier)).catch(() => {
    throw new Error("module file does not exist");
  });
  if (!isWithin(projectRoot, target)) throw new Error("module resolves outside the project directory");
  if (!(await stat(target)).isFile()) throw new Error("module is not a file");
  return pathToFileURL(target).href;
};

/**
 * Resolves all declared entrypoints before importing them and checks that each module
 * exports an adapter with the declared runtime name.
 */
export const loadDeclaredRuntimeAdapters = async (
  declared: DeclaredProjectAdapters,
  { provided = new Set() }: LoadProjectAdaptersOptions = {}
): Promise<RuntimeAdapterPlugin[]> => {
  const pending = declared.adapters.filter(([name]) => !provided.has(name));
  if (pending.length === 0) return [];
  const builtin = pending.find(([name]) => isBundledRuntimeAdapter(name));
  if (builtin) {
    throw new SpawnfileError(
      "invalid_manifest",
      `Invalid Spawnfile manifest ${declared.manifestPath}: adapters.${builtin[0]} names a bundled runtime; ` +
        "bundled runtimes cannot be replaced"
    );
  }
  const plugins = await importRuntimeAdapterModules(
    pending.map(([, specifier]) => ({
      resolveUrl: () => isLocalAdapterSpecifier(specifier)
        ? resolveLocalModule(declared.projectRoot, specifier)
        : resolveInstalledAdapterPackage(specifier, declared.projectRoot),
      specifier
    })),
    declared.manifestPath
  );
  for (const [index, plugin] of plugins.entries()) {
    const [name, specifier] = pending[index]!;
    if (plugin.adapter.name !== name) {
      throw new SpawnfileError(
        "validation_error",
        `Adapter ${JSON.stringify(specifier)} declared for runtime "${name}" in ${declared.manifestPath} ` +
          `exports adapter "${plugin.adapter.name}"; the declared runtime id must match the adapter name`
      );
    }
  }
  return plugins;
};

/** Loads the project's declared adapters for use with `withRuntimeAdapterPlugins`. */
export const loadProjectRuntimeAdapterPlugins = async (
  projectPath: string,
  options: LoadProjectAdaptersOptions = {}
): Promise<RuntimeAdapterPlugin[]> => {
  const declared = await readDeclaredProjectAdapters(projectPath);
  return declared ? loadDeclaredRuntimeAdapters(declared, options) : [];
};
