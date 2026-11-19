import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { DiagnosticReport } from "../report/index.js";
import type { RuntimeLifecycleStatus } from "../shared/index.js";
import { SpawnfileError } from "../shared/index.js";

import { builtinRuntimeRegistrations, type LegacyCredentialUidOption } from "./builtinAdapters.generated.js";
import { type RuntimeAdapterPlugin, validateRuntimeAdapterPlugin } from "./pluginDefinition.js";
import type { RuntimeAdapter } from "./types.js";

const runtimeAdapters = new Map(builtinRuntimeRegistrations.map(({ adapter }) => [adapter.name, adapter]));
export type ImageCredentialUidOptions = Partial<Record<LegacyCredentialUidOption, number>> & {
  containerCredentialUid?: number;
};

export const resolveImageCredentialUid = (name: string, options: ImageCredentialUidOptions): number | undefined => {
  const legacy = builtinRuntimeRegistrations.find(({ adapter }) => adapter.name === name)?.legacyCredentialUidOption;
  return options.containerCredentialUid ?? (legacy === undefined ? undefined : options[legacy]);
};

type AdapterScope = Map<string, { adapter: RuntimeAdapter; entry: RuntimeRegistryEntry }>;
const adapterScope = new AsyncLocalStorage<AdapterScope>();

const selectedRuntimeAdapter = (name: string): RuntimeAdapter | undefined =>
  adapterScope.getStore()?.get(name)?.adapter ?? runtimeAdapters.get(name);

const runtimeInstallSchema = z.discriminatedUnion("kind", [
  z
    .object({
      capability_receipt: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
      capability_receipts: z
        .object({
          amd64: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
          arm64: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
        })
        .strict()
        .refine((receipts) => Object.keys(receipts).length > 0, "capability_receipts must pin at least one architecture")
        .optional(),
      contract_manifest_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
      image: z.string().min(1),
      kind: z.literal("container_image"),
      tag: z.string().min(1)
    })
    .strict()
    .refine(
      (install) => !(install.capability_receipt && install.capability_receipts),
      "capability_receipt and capability_receipts are mutually exclusive"
    ),
  z
    .object({
      kind: z.literal("npm"),
      package: z.string().min(1),
      version: z.string().min(1)
    })
    .strict(),
  z
    .object({
      assets: z.record(z.string(), z.string().min(1)),
      binary: z.string().min(1),
      kind: z.literal("github_release_archive"),
      repository: z.string().min(1),
      tag: z.string().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("source_repo")
    })
    .strict()
]);

const runtimeRegistrySchema = z
  .object({
    runtimes: z.record(
      z.string(),
      z
        .object({
          default_branch: z.string().min(1),
          install: runtimeInstallSchema.optional(),
          ref: z.string().min(1),
          remote: z.string().min(1),
          status: z.enum(["active", "deprecated", "exploratory"])
        })
        .strict()
    )
  })
  .strict();

const runtimeRegistryUrl = new URL("../../runtimes.yaml", import.meta.url);

let runtimeRegistryPromise: Promise<RuntimeRegistryEntry[]> | undefined;

export type RuntimeRegistryInstall =
  | {
      capabilityReceipt?: string;
      /** Per-architecture receipts embedded in a multi-architecture image index. */
      capabilityReceipts?: RuntimeCapabilityReceipts;
      contractManifestSha256?: string;
      digest?: string;
      image: string;
      kind: "container_image";
      tag: string;
    }
  | {
      kind: "github_release_archive";
      assets: Record<string, string>;
      binary: string;
      repository: string;
      tag: string;
    }
  | {
      kind: "npm";
      package: string;
      version: string;
    }
  | {
      kind: "source_repo";
    };

export type RuntimeCapabilityReceipts = Partial<Record<"amd64" | "arm64", string>>;

export interface RuntimeRegistryEntry {
  training?: RuntimeAdapter["training"];
  defaultBranch: string;
  install?: RuntimeRegistryInstall;
  name: string;
  ref: string;
  remote: string;
  status: RuntimeLifecycleStatus;
}

const trainingFor = (adapter?: RuntimeAdapter): Pick<RuntimeRegistryEntry, "training"> =>
  adapter?.training ? { training: adapter.training } : {};

export const parseRuntimeRegistry = (source: string): RuntimeRegistryEntry[] => {
  try {
    const parsed = runtimeRegistrySchema.parse(parseYaml(source));

    return Object.entries(parsed.runtimes)
      .map(([name, entry]) => ({
        ...trainingFor(runtimeAdapters.get(name)),
        defaultBranch: entry.default_branch,
        install: entry.install?.kind === "container_image"
          ? {
              ...(entry.install.capability_receipt
                ? { capabilityReceipt: entry.install.capability_receipt }
                : {}),
              ...(entry.install.capability_receipts
                ? { capabilityReceipts: { ...entry.install.capability_receipts } }
                : {}),
              ...(entry.install.contract_manifest_sha256
                ? { contractManifestSha256: entry.install.contract_manifest_sha256 }
                : {}),
              ...(entry.install.digest ? { digest: entry.install.digest } : {}),
              image: entry.install.image,
              kind: entry.install.kind,
              tag: entry.install.tag
            }
          : entry.install,
        name,
        ref: entry.ref,
        remote: entry.remote,
        status: entry.status
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw new SpawnfileError(
        "runtime_error",
        `Invalid runtime registry: ${issue.message}`
      );
    }

    throw error;
  }
};

const readRuntimeRegistry = async (): Promise<RuntimeRegistryEntry[]> => {
  try {
    const source = await readFile(runtimeRegistryUrl, "utf8");
    return parseRuntimeRegistry(source);
  } catch (error) {
    if (error instanceof SpawnfileError) {
      throw error;
    }

    throw new SpawnfileError(
      "runtime_error",
      `Unable to read runtime registry at ${runtimeRegistryUrl.pathname}`
    );
  }
};

const loadBuiltinCatalog = (): Promise<RuntimeRegistryEntry[]> =>
  runtimeRegistryPromise ??= readRuntimeRegistry();

export const loadRuntimeRegistry = async (): Promise<RuntimeRegistryEntry[]> => {
  const catalog = await loadBuiltinCatalog();
  const scope = adapterScope.getStore();
  const selected = scope?.size
    ? [...catalog.filter((entry) => !scope.has(entry.name)), ...[...scope.values()].map(({ entry }) => entry)]
      .sort((left, right) => left.name.localeCompare(right.name))
    : catalog;
  return selected.map((entry) => ({
    ...entry,
    ...(entry.install ? { install: structuredClone(entry.install) } : {})
  }));
};

const registerScopedPlugins = async (scope: AdapterScope, plugins: readonly RuntimeAdapterPlugin[]): Promise<void> => {
  const catalog = plugins.length ? await loadBuiltinCatalog() : [];
  const offset = scope.size;
  const additions: AdapterScope = new Map();
  for (const [index, plugin] of plugins.entries()) {
    const { adapter, catalog: metadata } = validateRuntimeAdapterPlugin(plugin, `#${offset + index + 1}`);
    const name = adapter.name;
    if (scope.has(name) || additions.has(name)) {
      throw new SpawnfileError("validation_error", `Duplicate runtime adapter: ${name}`);
    }
    const existing = catalog.find((entry) => entry.name === name);
    if (runtimeAdapters.has(name) || (existing && existing.status !== "exploratory")) {
      throw new SpawnfileError("validation_error", `Runtime adapter ${name} cannot shadow a bundled adapter or active catalog entry`);
    }
    additions.set(name, { adapter, entry: { ...metadata, ...trainingFor(adapter), name, status: metadata.status ?? "active" } });
  }
  for (const [name, registration] of additions) scope.set(name, registration);
};

export const withRuntimeAdapterPlugins = async <T>(
  plugins: readonly RuntimeAdapterPlugin[],
  run: () => T | Promise<T>
): Promise<T> => {
  const scope: AdapterScope = new Map();
  await registerScopedPlugins(scope, plugins);
  try {
    return await adapterScope.run(scope, run);
  } finally {
    scope.clear();
  }
};

/**
 * Adds plugins to the innermost scope opened by `withRuntimeAdapterPlugins`, with the same
 * duplicate and shadowing refusals. Validation completes before any plugin becomes visible.
 */
export const addRuntimeAdapterPlugins = async (plugins: readonly RuntimeAdapterPlugin[]): Promise<void> => {
  const scope = adapterScope.getStore();
  if (!scope) throw new SpawnfileError("runtime_error", "Runtime adapters can only be added inside withRuntimeAdapterPlugins");
  await registerScopedPlugins(scope, plugins);
};

/** The adapter object an external plugin registered in this scope, never a bundled one. */
export const getScopedRuntimeAdapter = (runtimeName: string): RuntimeAdapter | undefined =>
  adapterScope.getStore()?.get(runtimeName)?.adapter;

export const getRegisteredRuntime = async (
  runtimeName: string
): Promise<RuntimeRegistryEntry | undefined> =>
  (await loadRuntimeRegistry()).find((entry) => entry.name === runtimeName);

export const isBundledRuntimeAdapter = (runtimeName: string): boolean => runtimeAdapters.has(runtimeName);

export const hasRuntimeAdapter = (runtimeName: string): boolean =>
  selectedRuntimeAdapter(runtimeName) !== undefined;

/** Runtime names a saved report refers to that this invocation has no adapter for. */
export const missingRuntimeAdapters = (runtimeNames: Iterable<string | null | undefined>): string[] =>
  [...new Set([...runtimeNames].filter((name): name is string => typeof name === "string" && name.length > 0))]
    .filter((name) => !hasRuntimeAdapter(name))
    .sort();

/**
 * Refuses an operation on report data naming a runtime with no adapter in this
 * invocation. A known adapter may have no hooks; only an absent one is refused.
 * Source project declarations and explicit CLI modules supply the registry for the operation.
 */
export const requireRuntimeAdapters = (
  runtimeNames: Iterable<string | null | undefined>,
  operation: string
): void => {
  const missing = missingRuntimeAdapters(runtimeNames);
  if (missing.length === 0) return;
  const listed = missing.map((name) => JSON.stringify(name)).join(", ");
  throw new SpawnfileError(
    "runtime_error",
    `Cannot ${operation}: no runtime adapter is loaded for ${listed}. ` +
      "Run it from the source project that declares the adapter, or pass --adapter <module>. " +
      "Spawnfile never loads an adapter named by report data."
  );
};

export const assertRuntimeCanCompile = async (
  runtimeName: string
): Promise<RuntimeRegistryEntry> => {
  const registeredRuntime = await getRegisteredRuntime(runtimeName);
  if (!registeredRuntime) {
    throw new SpawnfileError(
      "validation_error",
      `Unknown runtime binding: ${runtimeName}`
    );
  }

  if (registeredRuntime.status === "exploratory") {
    throw new SpawnfileError(
      "runtime_error",
      `Runtime ${runtimeName} is exploratory and cannot be compiled in v0.1`
    );
  }

  if (!hasRuntimeAdapter(runtimeName)) {
    throw new SpawnfileError(
      "runtime_error",
      `Runtime ${runtimeName} is marked ${registeredRuntime.status} in runtimes.yaml but has no bundled adapter`
    );
  }

  return registeredRuntime;
};

export const createRuntimeLifecycleDiagnostics = (
  runtime: Pick<RuntimeRegistryEntry, "name" | "ref" | "status">
): DiagnosticReport[] =>
  runtime.status === "deprecated"
    ? [
        {
          level: "warn",
          message: `Runtime ${runtime.name} is deprecated in Spawnfile and pinned at ${runtime.ref}`
        }
      ]
    : [];

export const getRuntimeAdapter = (runtimeName: string): RuntimeAdapter => {
  const adapter = selectedRuntimeAdapter(runtimeName);
  if (!adapter) {
    throw new SpawnfileError("runtime_error", `Unknown runtime adapter: ${runtimeName}`);
  }

  return adapter;
};

export const listRuntimeAdapters = (): string[] => [...runtimeAdapters.keys(), ...(adapterScope.getStore()?.keys() ?? [])].sort();

/** Saved reports may refer to a runtime that is no longer in this invocation. */
export const getRuntimeOperations = (runtimeName: string) => selectedRuntimeAdapter(runtimeName)?.operations;

export const listRuntimeOperations = () =>
  listRuntimeAdapters().flatMap((name) => {
    const operations = getRuntimeOperations(name);
    return operations ? [operations] : [];
  });

export * from "./legacyRegistry.generated.js";

export const defaultScaffoldRuntimeName = (): string => {
  const scaffold = builtinRuntimeRegistrations.find(({ adapter, defaultScaffoldRuntime }) =>
    defaultScaffoldRuntime && adapter.scaffoldAgentProject
  ) ?? builtinRuntimeRegistrations.find(({ adapter }) => adapter.scaffoldAgentProject);
  if (!scaffold) throw new SpawnfileError("runtime_error", "No bundled runtime supplies an agent scaffold");
  return scaffold.adapter.name;
};
