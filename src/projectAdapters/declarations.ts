import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { getManifestPath } from "../filesystem/index.js";
import { sortedAdapterEntries } from "../manifest/adapterSchemas.js";
import { parseManifestYaml, validateManifestDocument } from "../manifest/parseManifest.js";

/** Root adapter declarations read as data. Paths are canonical (realpath) and entries sorted by runtime id. */
export interface DeclaredProjectAdapters {
  adapters: ReadonlyArray<readonly [name: string, specifier: string]>;
  manifestPath: string;
  projectRoot: string;
}

const isMissing = (error: unknown): boolean =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * Reads the root `adapters` map as data. No module is resolved or imported here. A document
 * without an `adapters` key declares nothing and is left to the command's own validation; one
 * with the key must pass the public Spawnfile parser. A missing Spawnfile declares nothing.
 */
export const readDeclaredProjectAdapters = async (inputPath: string): Promise<DeclaredProjectAdapters | undefined> => {
  let manifestPath: string;
  let source: string;
  try {
    manifestPath = await realpath(getManifestPath(inputPath));
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const document = parseManifestYaml(source, manifestPath);
  if (typeof document !== "object" || document === null || !Object.hasOwn(document, "adapters")) return undefined;
  const adapters = validateManifestDocument(document, manifestPath).adapters;
  if (!adapters || Object.keys(adapters).length === 0) return undefined;
  return { adapters: sortedAdapterEntries(adapters), manifestPath, projectRoot: path.dirname(manifestPath) };
};
