import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { DiagnosticReport } from "../report/index.js";
import type { RuntimeLifecycleStatus } from "../shared/index.js";
import { SpawnfileError } from "../shared/index.js";

import { openClawAdapter } from "./openclaw/adapter.js";
import { picoClawAdapter } from "./picoclaw/adapter.js";
import { tinyClawAdapter } from "./tinyclaw/adapter.js";
import type { RuntimeAdapter } from "./types.js";

const runtimeAdapters = new Map<string, RuntimeAdapter>([
  [openClawAdapter.name, openClawAdapter],
  [picoClawAdapter.name, picoClawAdapter],
  [tinyClawAdapter.name, tinyClawAdapter]
]);

const runtimeInstallSchema = z.discriminatedUnion("kind", [
  z
    .object({
      image: z.string().min(1),
      kind: z.literal("container_image"),
      tag: z.string().min(1)
    })
    .strict(),
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
      asset: z.string().min(1),
      kind: z.literal("github_release_bundle"),
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
      kind: "github_release_bundle";
      asset: string;
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

export interface RuntimeRegistryEntry {
  defaultBranch: string;
  install?: RuntimeRegistryInstall;
  name: string;
  ref: string;
  remote: string;
  status: RuntimeLifecycleStatus;
}

export const parseRuntimeRegistry = (source: string): RuntimeRegistryEntry[] => {
  try {
    const parsed = runtimeRegistrySchema.parse(parseYaml(source));

    return Object.entries(parsed.runtimes)
      .map(([name, entry]) => ({
        defaultBranch: entry.default_branch,
        install: entry.install,
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

export const loadRuntimeRegistry = async (): Promise<RuntimeRegistryEntry[]> => {
  runtimeRegistryPromise ??= readRuntimeRegistry();
  return runtimeRegistryPromise;
};

export const getRegisteredRuntime = async (
  runtimeName: string
): Promise<RuntimeRegistryEntry | undefined> =>
  (await loadRuntimeRegistry()).find((entry) => entry.name === runtimeName);

export const hasRuntimeAdapter = (runtimeName: string): boolean =>
  runtimeAdapters.has(runtimeName);

export const assertRuntimeCanCompile = async (
  runtimeName: string
): Promise<RuntimeRegistryEntry> => {
  const registeredRuntime = await getRegisteredRuntime(runtimeName);
  if (!registeredRuntime) {
    throw new SpawnfileError(
      "runtime_error",
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
  const adapter = runtimeAdapters.get(runtimeName);
  if (!adapter) {
    throw new SpawnfileError("runtime_error", `Unknown runtime adapter: ${runtimeName}`);
  }

  return adapter;
};

export const listRuntimeAdapters = (): string[] => [...runtimeAdapters.keys()].sort();
