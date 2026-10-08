import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
import {
  resolveBundleRoot,
  resolveDevFiles,
  resolveReleaseFiles,
  writeBundleFiles,
  type BundleFilesInput,
  type BundleIdentityMode
} from "./workspaceBundleFiles.js";
import { WORKSPACE_BUNDLE_MAX_BYTES, WORKSPACE_BUNDLE_TAR_WRITER } from "./workspaceBundleTar.js";
import type { MoltnetTargetArchitecture } from "./moltnetReleaseAuthority.js";
import type { CompilePlan } from "./types.js";
import type { ResolvedWorkspaceResource } from "./workspaceResources.js";

const KEY_VERSION = "spawnfile.workspace-bundle-key.v1";

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
}

export interface ResolvedWorkspaceBundles {
  /** Digest → built archive already linked into the Docker context this compile. */
  built: Map<string, string>;
  report: CompileReportWorkspaceBundle[];
  builtCount: number;
  reusedCount: number;
}

type BundleResource = Extract<ResolvedWorkspaceResource, { kind: "bundle" }>;

/**
 * The cache key: every input file's path, mode and content identity, the
 * archive writer that turns them into bytes, and the target platform. A file
 * bundle's bytes do not vary by platform today, but the key carries it so one
 * cache serves every input kind under the same rule.
 */
export const computeWorkspaceBundleKey = (input: Pick<BundleFilesInput, "entries">, platform: string): string =>
  createHash("sha256").update(JSON.stringify({
    entries: input.entries.map((entry) => [entry.path, entry.mode, entry.identity]),
    input: "files",
    platform,
    version: KEY_VERSION,
    writer: WORKSPACE_BUNDLE_TAR_WRITER
  })).digest("hex");

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
 * Gives every bundle resource in the plan a concrete digest. Declared-input
 * bundles are built (or reused from the cache by key); prebuilt tars without a
 * declared digest are hashed. Staging verifies every prebuilt tar again from
 * the bytes it stages. Every bundle resource is reported with its digest.
 */
export const resolveWorkspaceBundles = async (plan: CompilePlan, options: ResolveWorkspaceBundlesOptions): Promise<ResolvedWorkspaceBundles> => {
  const result: ResolvedWorkspaceBundles = { built: new Map(), builtCount: 0, report: [], reusedCount: 0 };
  const memo = new Map<string, Promise<BundleFacts>>();
  const cacheDirectory = resolveWorkspaceBundleCacheDirectory(options.cacheDirectory), { outputDirectory } = options;
  let platform = "";
  const identity = options.identity ?? "dev", usedKeys = new Set<string>();

  const resolveOne = async (resource: BundleResource): Promise<BundleFacts> => {
    const base = path.dirname(resource.scope.key);
    if (resource.source !== undefined) {
      return { origin: "prebuilt", sha256: resource.sha256 ?? await hashPrebuilt(path.resolve(base, resource.source)) };
    }
    platform ||= `linux/${resolveBundleArchitecture(options.architecture)}`;
    const files = resource.build!.files, root = await resolveBundleRoot(path.resolve(base, files.root));
    const input = identity === "release" ? await resolveReleaseFiles(root, files.exclude) : await resolveDevFiles(root, files.exclude);
    const key = computeWorkspaceBundleKey(input, platform);
    usedKeys.add(key);
    // Link into this compile's context immediately: once linked, a concurrent compile's pruning cannot take it away.
    // A hit pruned between lookup and link is rebuilt.
    let cached = await lookupCachedBundle(cacheDirectory, key), staged = cached && await linkBuiltBundle(cached.tarPath, outputDirectory, cached.sha256);
    if (cached && staged) result.reusedCount += 1;
    else {
      cached = await storeBuiltBundle(cacheDirectory, key, (temporaryPath) => writeBundleFiles(input, temporaryPath));
      staged = await linkBuiltBundle(cached.tarPath, outputDirectory, cached.sha256);
      if (!staged) throw new SpawnfileError("compile_error", `Workspace bundle archive vanished from the cache while it was staged: ${key}`);
      result.builtCount += 1;
    }
    result.built.set(cached.sha256, staged);
    return { cache_key: key, content_bytes: cached.contentBytes, file_count: cached.fileCount, identity, origin: "built", platform, sha256: cached.sha256 };
  };

  for (const node of plan.nodes) {
    if (node.kind !== "agent" || !node.value.workspaceResources?.some((resource) => resource.kind === "bundle")) continue;
    const resources: ResolvedWorkspaceResource[] = [];
    for (const resource of node.value.workspaceResources) {
      if (resource.kind !== "bundle") { resources.push(resource); continue; }
      const memoKey = declarationKey(resource);
      if (!memo.has(memoKey)) memo.set(memoKey, resolveOne(resource));
      const facts = await memo.get(memoKey)!;
      if (resource.sha256 !== undefined && resource.sha256 !== facts.sha256) {
        throw new SpawnfileError("validation_error", `Workspace bundle ${resource.id} built to ${facts.sha256}, but it declares ${resource.sha256}`);
      }
      if (!result.report.some((existing) => existing.id === resource.id && existing.sha256 === facts.sha256)) result.report.push({ id: resource.id, ...facts });
      resources.push({ ...resource, sha256: facts.sha256 });
    }
    node.value.workspaceResources = resources;
  }
  if (usedKeys.size > 0) await pruneBundleCache(cacheDirectory, usedKeys);
  result.report.sort((left, right) => left.id.localeCompare(right.id) || left.sha256.localeCompare(right.sha256));
  return result;
};
