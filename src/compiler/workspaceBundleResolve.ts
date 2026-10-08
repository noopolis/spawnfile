import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CompileReportWorkspaceBundle } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";

import { validateWorkspaceBundleTar } from "./workspaceBundleArtifacts.js";
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
import { resolveTargetArchitecture } from "./moltnetBinaries.js";
import type { MoltnetTargetArchitecture } from "./moltnetReleaseAuthority.js";
import type { CompilePlan } from "./types.js";
import type { ResolvedWorkspaceResource } from "./workspaceResources.js";

const KEY_VERSION = "spawnfile.workspace-bundle-key.v1";

export interface ResolveWorkspaceBundlesOptions {
  /** Target container architecture; resolved like the Moltnet binaries when omitted. */
  architecture?: MoltnetTargetArchitecture;
  /** Defaults to `$SPAWNFILE_HOME/cache/workspace-bundles`. */
  cacheDirectory?: string;
  /** `release` requires clean inputs and takes identity from the committed tree; `dev` (default) hashes the work tree. */
  identity?: BundleIdentityMode;
}

export interface ResolvedWorkspaceBundles {
  /** Digest → archive already verified this compile; staging copies these without re-reading them. */
  verified: Map<string, string>;
  report: CompileReportWorkspaceBundle[];
  built: number;
  reused: number;
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
  build: resource.build ?? null, scope: path.dirname(resource.scope.key), sha256: resource.sha256 ?? null, source: resource.source ?? null
});

const hashPrebuilt = async (source: string): Promise<string> => {
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile() || info.size < 1 || info.size > WORKSPACE_BUNDLE_MAX_BYTES) throw new SpawnfileError("validation_error", "Workspace bundle must be a bounded regular tar file");
  const bytes = await readFile(source);
  validateWorkspaceBundleTar(bytes);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
};

/**
 * Gives every bundle resource in the plan a concrete digest. Declared-input
 * bundles are built (or reused from the cache by key); prebuilt tars without a
 * declared digest are hashed. Prebuilt tars that declare `sha256` are left to
 * staging, which verifies them exactly as before.
 */
export const resolveWorkspaceBundles = async (plan: CompilePlan, options: ResolveWorkspaceBundlesOptions): Promise<ResolvedWorkspaceBundles> => {
  const result: ResolvedWorkspaceBundles = { built: 0, report: [], reused: 0, verified: new Map() };
  const memo = new Map<string, Promise<{ digest: string; entry: CompileReportWorkspaceBundle }>>();
  const cacheDirectory = resolveWorkspaceBundleCacheDirectory(options.cacheDirectory);
  let platform = "";
  const identity = options.identity ?? "dev", usedKeys = new Set<string>();

  const resolveOne = async (resource: BundleResource): Promise<{ digest: string; entry: CompileReportWorkspaceBundle }> => {
    const base = path.dirname(resource.scope.key);
    if (resource.source !== undefined) {
      const source = path.resolve(base, resource.source), digest = await hashPrebuilt(source);
      result.verified.set(digest, source);
      return { digest, entry: { id: resource.id, origin: "prebuilt", sha256: digest } };
    }
    platform ||= `linux/${resolveTargetArchitecture(options.architecture)}`;
    const files = resource.build!.files, root = await resolveBundleRoot(path.resolve(base, files.root));
    const input = identity === "release" ? await resolveReleaseFiles(root, files.exclude) : await resolveDevFiles(root, files.exclude);
    const key = computeWorkspaceBundleKey(input, platform);
    usedKeys.add(key);
    let cached = await lookupCachedBundle(cacheDirectory, key);
    if (cached) result.reused += 1;
    else {
      cached = await storeBuiltBundle(cacheDirectory, key, (temporaryPath) => writeBundleFiles(input, temporaryPath));
      result.built += 1;
    }
    if (resource.sha256 !== undefined && resource.sha256 !== cached.sha256) {
      throw new SpawnfileError("validation_error", `Workspace bundle ${resource.id} built to ${cached.sha256}, but it declares ${resource.sha256}`);
    }
    result.verified.set(cached.sha256, cached.tarPath);
    return {
      digest: cached.sha256,
      entry: { cache_key: key, content_bytes: cached.contentBytes, file_count: cached.fileCount, id: resource.id, identity, origin: "built", platform, sha256: cached.sha256 }
    };
  };

  for (const node of plan.nodes) {
    if (node.kind !== "agent" || !node.value.workspaceResources?.some((resource) => resource.kind === "bundle")) continue;
    const resources: ResolvedWorkspaceResource[] = [];
    for (const resource of node.value.workspaceResources) {
      if (resource.kind !== "bundle" || (resource.source !== undefined && resource.sha256 !== undefined)) { resources.push(resource); continue; }
      const memoKey = declarationKey(resource);
      if (!memo.has(memoKey)) memo.set(memoKey, resolveOne(resource));
      const { digest, entry } = await memo.get(memoKey)!;
      if (!result.report.some((existing) => existing.id === entry.id && existing.sha256 === entry.sha256)) result.report.push(entry);
      resources.push({ ...resource, sha256: digest });
    }
    node.value.workspaceResources = resources;
  }
  if (usedKeys.size > 0) await pruneBundleCache(cacheDirectory, usedKeys);
  result.report.sort((left, right) => left.id.localeCompare(right.id) || left.sha256.localeCompare(right.sha256));
  return result;
};
