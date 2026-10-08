import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { CompileReportWorkspaceBundle } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";

import { linkBuiltBundle, validateWorkspaceBundleTar } from "./workspaceBundleArtifacts.js";
import {
  lookupCachedBundle,
  pruneBundleCache,
  resolveWorkspaceBundleCacheDirectory,
  storeBuiltBundle
} from "./workspaceBundleCache.js";
import { planDependenciesBundle } from "./workspaceBundleDependencies.js";
import type { BundleIdentityMode } from "./workspaceBundleFiles.js";
import { planFilesBundle, planGeneratedBundle } from "./workspaceBundleGenerated.js";
import type { BundleBuildContext, BundleBuildPlan } from "./workspaceBundleKey.js";
import { WORKSPACE_BUNDLE_MAX_BYTES } from "./workspaceBundleTar.js";
import type { MoltnetTargetArchitecture } from "./moltnetReleaseAuthority.js";
import type { CompilePlan } from "./types.js";
import { resolveBundleBuildPaths, type ResolvedWorkspaceResource } from "./workspaceResources.js";
import type { WorkspaceBundleBuild } from "../manifest/index.js";

/** One build plan per declaration; `build` paths are already absolute. */
export const planBundleBuild = (build: WorkspaceBundleBuild, context: BundleBuildContext, options: { captureTools?: boolean } = {}): Promise<BundleBuildPlan> =>
  build.files ? planFilesBundle(build.files, context)
    : build.dependencies ? planDependenciesBundle(build.dependencies, context)
      : planGeneratedBundle(build.generated!, context, options);

/** Explicit, else the same target-arch override the Moltnet binaries honour, else the host. */
export const resolveBundleArchitecture = (architecture?: MoltnetTargetArchitecture): MoltnetTargetArchitecture => {
  const value = architecture ?? (process.env.SPAWNFILE_MOLTNET_TARGET_ARCH?.trim() || process.arch);
  if (value === "amd64" || value === "x64" || value === "x86_64") return "amd64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  throw new SpawnfileError("compile_error", `Workspace bundles do not support target architecture ${value}`);
};

export interface ResolveWorkspaceBundlesOptions {
  /** Compile output directory; built archives are linked into its Docker context as soon as they resolve. */
  outputDirectory: string;
  /** Target container architecture; resolved like the Moltnet binaries when omitted. */
  architecture?: MoltnetTargetArchitecture;
  /** Defaults to `$SPAWNFILE_HOME/cache/workspace-bundles`. */
  cacheDirectory?: string;
  /** `release` requires clean inputs and takes identity from the committed tree; `dev` (default) hashes the work tree. */
  identity?: BundleIdentityMode;
  /** Docker CLI for dependency installs and image-run generated steps (cache misses only). */
  dockerCommand?: string;
}

export interface ResolvedWorkspaceBundles {
  /** Digest → built archive already linked into the Docker context this compile. */
  built: Map<string, string>;
  report: CompileReportWorkspaceBundle[];
  builtCount: number;
  reusedCount: number;
}

type BundleResource = Extract<ResolvedWorkspaceResource, { kind: "bundle" }>;

export { computeWorkspaceBundleKey } from "./workspaceBundleKey.js";

const declarationKey = (resource: BundleResource): string => JSON.stringify({
  build: resource.build ?? null, scope: path.dirname(resource.scope.key), source: resource.source ?? null
});

const hashPrebuilt = async (source: string): Promise<string> => {
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile() || info.size < 1 || info.size > WORKSPACE_BUNDLE_MAX_BYTES) throw new SpawnfileError("validation_error", "Workspace bundle must be a bounded regular tar file");
  const bytes = await readFile(source);
  validateWorkspaceBundleTar(bytes);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
};

type BundleFacts = Omit<CompileReportWorkspaceBundle, "id">;

/**
 * A stable pin for a bundle without building it: the declared or computed
 * archive digest for a prebuilt tar, else `bundle-key:<key>` — the cache key a
 * dev compile for the target architecture would build under, which moves with
 * every input, recipe and platform change — or, for a generated bundle,
 * `bundle-recipe:<key>`, the same key with tools identified by argv only.
 * Nothing is installed, generated or executed.
 */
export const pinWorkspaceBundle = async (resource: BundleResource, options: { architecture?: MoltnetTargetArchitecture; cacheDirectory?: string; dockerCommand?: string } = {}): Promise<string> => {
  const base = path.dirname(resource.scope.key);
  if (resource.source !== undefined) return resource.sha256 ?? hashPrebuilt(path.resolve(base, resource.source));
  const plan = await planBundleBuild(resolveBundleBuildPaths(resource.build!, base), {
    dockerCommand: options.dockerCommand ?? "docker", identity: "dev", outputReal: path.join(base, ".spawnfile-no-output"),
    platform: `linux/${resolveBundleArchitecture(options.architecture)}`, workRoot: path.join(resolveWorkspaceBundleCacheDirectory(options.cacheDirectory), "work")
  }, { captureTools: false });
  // A generated bundle's build key includes captured tool output, which a pin never executes to obtain.
  return `${plan.input === "generated" ? "bundle-recipe" : "bundle-key"}:${plan.key}`;
};

/**
 * Gives every bundle resource in the plan a concrete digest. Declared-input
 * bundles are built (or reused from the cache by key); prebuilt tars without a
 * declared digest are hashed. Staging verifies every prebuilt tar again from
 * the bytes it stages. Every bundle resource is reported with its digest.
 */
export const resolveWorkspaceBundles = async (plan: CompilePlan, options: ResolveWorkspaceBundlesOptions): Promise<ResolvedWorkspaceBundles> => {
  const result: ResolvedWorkspaceBundles = { built: new Map(), builtCount: 0, report: [], reusedCount: 0 };
  const cacheDirectory = resolveWorkspaceBundleCacheDirectory(options.cacheDirectory), { outputDirectory } = options;
  const identity = options.identity ?? "dev", usedKeys = new Set<string>();
  const bundles = plan.nodes.flatMap((node) => node.kind === "agent" ? (node.value.workspaceResources ?? []).filter((resource): resource is BundleResource => resource.kind === "bundle") : []);
  if (bundles.length === 0) return result;
  const outputReal = await realpath(outputDirectory).catch(() => path.resolve(outputDirectory));
  let platform = "";

  // Phase 1: every input snapshot is taken before this compile writes anything, so no
  // staged archive (or other output under a bundle root) can leak into a later bundle.
  const planned = new Map<string, Promise<{ facts: BundleFacts } | BundleBuildPlan>>();
  for (const resource of bundles) {
    const memoKey = declarationKey(resource);
    if (planned.has(memoKey)) continue;
    const base = path.dirname(resource.scope.key);
    planned.set(memoKey, (async () => {
      if (resource.source !== undefined) {
        return { facts: { origin: "prebuilt" as const, sha256: resource.sha256 ?? await hashPrebuilt(path.resolve(base, resource.source)) } };
      }
      platform ||= `linux/${resolveBundleArchitecture(options.architecture)}`;
      return planBundleBuild(resolveBundleBuildPaths(resource.build!, base), {
        dockerCommand: options.dockerCommand ?? "docker", identity, outputReal, platform, workRoot: path.join(cacheDirectory, "work")
      });
    })());
    await planned.get(memoKey);
  }

  // Phase 2: build or reuse each archive and link it into this compile's context at once,
  // so a concurrent compile's pruning cannot take it away. A hit pruned before linking is rebuilt.
  const facts = new Map<string, BundleFacts>();
  for (const [memoKey, pending] of planned) {
    const step = await pending;
    if ("facts" in step) { facts.set(memoKey, step.facts); continue; }
    const { input, key, write } = step;
    usedKeys.add(key);
    let cached = await lookupCachedBundle(cacheDirectory, key), staged = cached && await linkBuiltBundle(cached.tarPath, outputDirectory, cached.sha256);
    if (cached && staged) result.reusedCount += 1;
    else {
      cached = await storeBuiltBundle(cacheDirectory, key, write);
      staged = await linkBuiltBundle(cached.tarPath, outputDirectory, cached.sha256);
      if (!staged) throw new SpawnfileError("compile_error", `Workspace bundle archive vanished from the cache while it was staged: ${key}`);
      result.builtCount += 1;
    }
    result.built.set(cached.sha256, staged);
    facts.set(memoKey, { cache_key: key, content_bytes: cached.contentBytes, file_count: cached.fileCount, identity, input, origin: "built", platform, sha256: cached.sha256 });
  }

  for (const node of plan.nodes) {
    if (node.kind !== "agent" || !node.value.workspaceResources?.some((resource) => resource.kind === "bundle")) continue;
    node.value.workspaceResources = node.value.workspaceResources.map((resource) => {
      if (resource.kind !== "bundle") return resource;
      const resolved = facts.get(declarationKey(resource))!;
      if (resource.sha256 !== undefined && resource.sha256 !== resolved.sha256) {
        throw new SpawnfileError("validation_error", `Workspace bundle ${resource.id} built to ${resolved.sha256}, but it declares ${resource.sha256}`);
      }
      if (!result.report.some((existing) => existing.id === resource.id && existing.sha256 === resolved.sha256)) result.report.push({ id: resource.id, ...resolved });
      return { ...resource, sha256: resolved.sha256 };
    });
  }
  if (usedKeys.size > 0) await pruneBundleCache(cacheDirectory, usedKeys);
  result.report.sort((left, right) => left.id.localeCompare(right.id) || left.sha256.localeCompare(right.sha256));
  return result;
};
