import os from "node:os";
import path from "node:path";

import type { CompileReportWorkspaceGitResource } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";

import { linkBuiltBundle } from "./workspaceBundleArtifacts.js";
import { lookupCachedBundle, pruneBundleCache, resolveWorkspaceBundleCacheDirectory, storeBuiltBundle } from "./workspaceBundleCache.js";
import { listCommittedTree } from "./workspaceBundleGit.js";
import { compileExcludePatterns, writeBundleFiles, type BundleFileEntry, type BundleIdentityMode } from "./workspaceBundleFiles.js";
import { computeWorkspaceBundleKey, resolveBundleArchitecture } from "./workspaceBundleResolve.js";
import { normalizeBundleMode } from "./workspaceBundleTar.js";
import { fetchGitPin, withGitPinEnvironment, type GitPinAuth, type GitPinSelector } from "./workspaceGitFetch.js";
import type { MoltnetTargetArchitecture } from "./moltnetReleaseAuthority.js";
import type { CompilePlan } from "./types.js";
import type { ResolvedWorkspaceResource } from "./workspaceResources.js";

type GitResource = Extract<ResolvedWorkspaceResource, { kind: "git" }>;

export interface ResolveWorkspaceGitPinsOptions {
  outputDirectory: string;
  architecture?: MoltnetTargetArchitecture;
  /** The workspace bundle cache directory; git objects and archives live beside it under `git-resources/`. */
  bundleCacheDirectory?: string;
  identity?: BundleIdentityMode;
  environment?: NodeJS.ProcessEnv;
}

export interface ResolvedWorkspaceGitPins {
  /** Digest → archive linked into the Docker context, for `stageWorkspaceBundles`. */
  built: Map<string, string>;
  report: CompileReportWorkspaceGitResource[];
}

const SYMLINK = 0o120000, GITLINK = 0o160000;

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};

export const isBuildPinnedGitResource = (resource: ResolvedWorkspaceResource): resource is GitResource =>
  resource.kind === "git" && resource.fetch === "build";

const selectorOf = (resource: GitResource): GitPinSelector =>
  resource.branch ? { kind: "branch", value: resource.branch.trim() }
    : resource.tag ? { kind: "tag", value: resource.tag.trim() }
      : resource.ref ? { kind: "ref", value: resource.ref.trim() }
        : { kind: "none", value: "" };

const expandPath = (value: string, base: string): string =>
  value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : path.resolve(base, value);

const authOf = (resource: GitResource): GitPinAuth | undefined => {
  if (!resource.auth) return undefined;
  return resource.auth.ssh_key !== undefined
    ? { sshKey: expandPath(resource.auth.ssh_key, path.dirname(resource.scope.key)) }
    : { sshKeyEnv: resource.auth.ssh_key_env! };
};

const declarationKey = (resource: GitResource): string => JSON.stringify({
  auth: authOf(resource) ?? null, exclude: resource.exclude ?? null, selector: selectorOf(resource), url: resource.url.trim()
});

/** The committed tree as bundle entries: blob ids and modes only, under the same safety rules as built bundles. */
const treeEntries = async (resource: GitResource, repository: string, commit: string): Promise<BundleFileEntry[]> => {
  const excluded = compileExcludePatterns(resource.exclude);
  const entries: BundleFileEntry[] = [];
  for (const entry of await listCommittedTree(repository, commit)) {
    if (excluded(entry.path)) continue;
    if (entry.mode === SYMLINK) fail(`Workspace git resource ${resource.id} contains a symlink; exclude it: ${entry.path}`);
    if (entry.mode === GITLINK) fail(`Workspace git resource ${resource.id} contains a submodule; exclude it: ${entry.path}`);
    if (entry.type !== "blob") fail(`Workspace git resource ${resource.id} has unsupported git type ${entry.type}: ${entry.path}`);
    if (!entry.path || entry.path.includes("\\") || entry.path.split("/").some((part) => !part || part === "." || part === "..")) {
      fail(`Workspace git resource ${resource.id} path cannot be archived safely: ${entry.path}`);
    }
    entries.push({ identity: `git:${entry.objectId}`, mode: normalizeBundleMode(entry.mode), objectId: entry.objectId, path: entry.path });
  }
  if (entries.length === 0) fail(`Workspace git resource ${resource.id} has no files at ${commit}`);
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
};

/**
 * Lowers every `fetch: build` git resource into a pinned read-only bundle:
 * the declared branch, tag or ref is resolved on the host to one commit, that
 * commit's tree is archived deterministically (the same writer as built
 * bundles), and the agent mounts the archive exactly as it mounts a bundle.
 * No credential, clone or network access reaches the container. The commit
 * and archive digest are recorded in the compile report; declaring
 * `ref: <commit>` reproduces the identical archive.
 */
export const resolveWorkspaceGitPins = async (plan: CompilePlan, options: ResolveWorkspaceGitPinsOptions): Promise<ResolvedWorkspaceGitPins> => {
  const result: ResolvedWorkspaceGitPins = { built: new Map(), report: [] };
  const pinned = plan.nodes.flatMap((node) => node.kind === "agent" ? (node.value.workspaceResources ?? []).filter(isBuildPinnedGitResource) : []);
  if (pinned.length === 0) return result;
  const root = path.join(path.dirname(resolveWorkspaceBundleCacheDirectory(options.bundleCacheDirectory)), "git-resources");
  const objects = path.join(root, "objects"), archives = path.join(root, "archives");
  const platform = `linux/${resolveBundleArchitecture(options.architecture)}`, identity = options.identity ?? "dev";
  const resolved = new Map<string, { commit: string; facts: CompileReportWorkspaceGitResource }>(), usedKeys = new Set<string>();

  for (const resource of pinned) {
    const memoKey = declarationKey(resource);
    if (resolved.has(memoKey)) continue;
    const selector = selectorOf(resource), auth = authOf(resource), url = resource.url.trim();
    const { commit, repository } = await withGitPinEnvironment(auth, (env) => fetchGitPin(objects, url, selector, env), options.environment);
    const entries = await treeEntries(resource, repository, commit);
    const key = computeWorkspaceBundleKey({ entries }, platform);
    usedKeys.add(key);
    let cached = await lookupCachedBundle(archives, key), staged = cached && await linkBuiltBundle(cached.tarPath, options.outputDirectory, cached.sha256);
    if (!cached || !staged) {
      cached = await storeBuiltBundle(archives, key, (temporaryPath) => writeBundleFiles({ directory: repository, entries, mode: "release" }, temporaryPath));
      staged = await linkBuiltBundle(cached.tarPath, options.outputDirectory, cached.sha256);
      if (!staged) throw new SpawnfileError("compile_error", `Workspace git resource archive vanished from the cache while it was staged: ${key}`);
    }
    result.built.set(cached.sha256, staged);
    resolved.set(memoKey, {
      commit,
      facts: {
        auth: auth === undefined ? "none" : auth.sshKey !== undefined ? "ssh_key" : "ssh_key_env",
        cache_key: key, commit, content_bytes: cached.contentBytes, file_count: cached.fileCount, id: resource.id, identity,
        platform, selector: selector.kind === "none" ? { kind: "default_branch" } : { kind: selector.kind, value: selector.value },
        sha256: cached.sha256, url
      }
    });
  }

  for (const node of plan.nodes) {
    if (node.kind !== "agent" || !node.value.workspaceResources?.some(isBuildPinnedGitResource)) continue;
    node.value.workspaceResources = node.value.workspaceResources.map((resource): ResolvedWorkspaceResource => {
      if (!isBuildPinnedGitResource(resource)) return resource;
      const { facts } = resolved.get(declarationKey(resource))!;
      if (!result.report.some((existing) => existing.id === resource.id && existing.sha256 === facts.sha256)) result.report.push({ ...facts, id: resource.id });
      // From here on it is a bundle: same staging, same identity-checked read-only mount, no auth fields.
      return { id: resource.id, kind: "bundle", mode: "readonly", mount: resource.mount, scope: resource.scope, sha256: facts.sha256, sharing: "per_agent" };
    });
  }
  await pruneBundleCache(archives, usedKeys);
  result.report.sort((left, right) => left.id.localeCompare(right.id) || left.sha256.localeCompare(right.sha256));
  return result;
};
