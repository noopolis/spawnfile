// Resolves `<resource id>` in a Spawnfile project to a FeedTarget: the declared feed (paths resolved
// against the declaring manifest), the host path of the named volume, and the host state directory.

import path from "node:path";

import { buildCompilePlan } from "../compiler/index.js";
import type { TeamWorkspaceResource } from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

import { feedError } from "./feedLayout.js";
import { hostExec, type FeedExec } from "./feedSource.js";
import { DEFAULT_FEED_HEAL_LIMIT, DEFAULT_FEED_KEEP, DEFAULT_FEED_VALIDATE_TIMEOUT_MS, type FeedTarget } from "./feedTarget.js";

type VolumeResource = Extract<TeamWorkspaceResource, { kind: "volume" }>;
type DeclaredFeed = NonNullable<VolumeResource["feed"]>;

export interface FeedTargetOptions {
  exec?: FeedExec;
  fetch?: boolean;
  healLimit?: number;
  stateDir?: string;
  validateTimeoutMs?: number;
  volumePath?: string;
}

export interface DeclaredVolumeFeed {
  /** Directory of the manifest that declared the resource; relative feed paths resolve here. */
  base: string;
  feed: DeclaredFeed;
  id: string;
  name: string;
}

/** Every fed volume visible in the compile plan, deduplicated by id (team resources reach many agents). */
export const findDeclaredVolumeFeeds = async (inputPath: string): Promise<DeclaredVolumeFeed[]> => {
  const plan = await buildCompilePlan(inputPath);
  const byId = new Map<string, DeclaredVolumeFeed>();
  for (const node of plan.nodes) {
    for (const resource of node.value.workspaceResources ?? []) {
      if (resource.kind !== "volume" || !resource.feed || byId.has(resource.id)) continue;
      byId.set(resource.id, { base: path.dirname(resource.scope.key), feed: resource.feed, id: resource.id, name: resource.name as string });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

/** `docker volume inspect` names the host directory of a named volume; the override serves other hosts and tests. */
export const resolveVolumeHostPath = (name: string, { exec = hostExec, volumePath }: { exec?: FeedExec; volumePath?: string }): string => {
  if (volumePath) return path.resolve(volumePath);
  try {
    const mountpoint = exec("docker", ["volume", "inspect", "--format", "{{.Mountpoint}}", name]).toString().trim();
    if (!path.isAbsolute(mountpoint)) throw new Error(`unexpected mountpoint ${JSON.stringify(mountpoint)}`);
    return mountpoint;
  } catch (error) {
    throw feedError(`cannot find the host path of volume ${name}: ${String((error as Error).message).trim().slice(0, 200)}. Deploy the organization once, or pass --volume-path.`);
  }
};

export const toFeedTarget = (declared: DeclaredVolumeFeed, options: FeedTargetOptions = {}): FeedTarget => {
  const volume = resolveVolumeHostPath(declared.name, options);
  const feed = declared.feed;
  const source: FeedTarget["source"] = feed.git
    ? { fetch: options.fetch ?? feed.git.fetch ?? false, kind: "git", ...(feed.git.paths ? { paths: feed.git.paths } : {}), ref: feed.git.ref ?? "HEAD", repo: path.resolve(declared.base, feed.git.repo) }
    : { directory: path.resolve(declared.base, feed.directory as string), kind: "directory" };
  return {
    healLimit: options.healLimit ?? DEFAULT_FEED_HEAL_LIMIT,
    keep: feed.keep ?? DEFAULT_FEED_KEEP,
    ...(feed.owner ? { owner: feed.owner } : {}),
    resourceId: declared.id,
    source,
    // Beside the volume's content root: the same filesystem (rename stays atomic), never inside it.
    stateDir: path.resolve(options.stateDir ?? path.join(path.dirname(volume), "spawnfile-feed")),
    ...(feed.validate ? { validate: { command: feed.validate, cwd: declared.base, timeoutMs: options.validateTimeoutMs ?? DEFAULT_FEED_VALIDATE_TIMEOUT_MS } } : {}),
    volume,
    volumeName: declared.name
  };
};

export const resolveFeedTarget = async (inputPath: string, resourceId: string, options: FeedTargetOptions = {}): Promise<FeedTarget> => {
  const feeds = await findDeclaredVolumeFeeds(inputPath);
  const declared = feeds.find((entry) => entry.id === resourceId);
  if (!declared) {
    throw new SpawnfileError("validation_error", `no fed volume ${resourceId} in ${inputPath}${feeds.length ? `; fed volumes: ${feeds.map((entry) => entry.id).join(", ")}` : "; no volume declares feed"}`);
  }
  return toFeedTarget(declared, options);
};
