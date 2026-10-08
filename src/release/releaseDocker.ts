import type { DockerCommandRunner } from "../distribution/dockerRunner.js";

import { ReleaseError } from "./types.js";

/** Release images are `<repository>:r-<first 12 hex of the identity>`. */
export const RELEASE_TAG_PREFIX = "r-";

export const releaseImageTag = (repository: string, identity: string): string =>
  `${repository}:${RELEASE_TAG_PREFIX}${identity.replace(/^sha256:/u, "").slice(0, 12)}`;

export interface RunningUnit {
  health: string;
  id: string;
  imageId: string;
  restartCount: number;
  running: boolean;
}

// `.State.Health` is absent (not null) without a healthcheck, and Go templates
// fail on a missing map key, so the whole State object is read and parsed here.
const INSPECT_FORMAT = "{{json .Id}}\t{{json .Image}}\t{{json .State}}\t{{json .RestartCount}}";

/** Null when the container does not exist; a container that exists but cannot be parsed is an error. */
export const inspectUnit = async (runDocker: DockerCommandRunner, containerRef: string): Promise<RunningUnit | null> => {
  let raw: string;
  try {
    raw = (await runDocker(["container", "inspect", "--format", INSPECT_FORMAT, containerRef], { timeoutMs: 15_000 })).toString("utf8").trim();
  } catch (error) {
    if (/no such (container|object)/iu.test((error as Error).message)) return null;
    throw new ReleaseError("blocked", `cannot inspect container ${containerRef}: ${(error as Error).message.slice(0, 200)}`);
  }
  try {
    const [id, imageId, state, restarts] = raw.split("\t").map((field) => JSON.parse(field) as unknown);
    const { Health: health, Running: running } = (state ?? {}) as { Health?: { Status?: unknown }; Running?: unknown };
    const status = health === undefined || health === null ? "none" : health.Status;
    if (typeof id !== "string" || typeof imageId !== "string" || typeof running !== "boolean" || typeof status !== "string" || typeof restarts !== "number") throw new Error();
    return { health: status, id, imageId, restartCount: restarts, running };
  } catch {
    throw new ReleaseError("blocked", `container ${containerRef} returned an unreadable inspection`);
  }
};

export interface SettleOptions {
  pollMs: number;
  polls: number;
  sleep?: (ms: number) => Promise<void>;
  stablePolls: number;
}

/**
 * Started is not working. A container that is "running (health: starting)"
 * has proved nothing, and a crash-looping one reports `running` between
 * restarts, so this waits until the same healthy observation, restart count
 * included, holds for `stablePolls` consecutive polls.
 */
export const settleUnit = async (runDocker: DockerCommandRunner, containerRef: string, options: SettleOptions): Promise<RunningUnit> => {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: string | null = null;
  let stable = 0;
  let observed: RunningUnit | null = null;
  for (let poll = 0; poll < options.polls; poll += 1) {
    let failure: string | null = null;
    observed = await inspectUnit(runDocker, containerRef).catch((error: unknown) => { failure = (error as Error).message.slice(0, 160); return null; });
    const healthy = observed !== null && observed.running && (observed.health === "healthy" || observed.health === "none");
    const key = observed ? `${observed.id} ${observed.running} ${observed.health} ${observed.restartCount}` : failure ?? "missing";
    stable = healthy && key === last ? stable + 1 : healthy ? 1 : 0;
    last = key;
    if (stable >= options.stablePolls) return observed!;
    if (poll + 1 < options.polls) await sleep(options.pollMs);
  }
  throw new ReleaseError("health-failed", `the deployed container never settled healthy; last observed: ${last ?? "nothing"}`);
};

const inUseImageIds = async (runDocker: DockerCommandRunner): Promise<Set<string>> => {
  const ids = (await runDocker(["ps", "-a", "-q", "--no-trunc"])).toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  if (ids.length === 0) return new Set();
  const images = (await runDocker(["container", "inspect", "--format", "{{.Image}}", ...ids])).toString("utf8");
  return new Set(images.split("\n").map((line) => line.trim()).filter(Boolean));
};

export interface PruneResult {
  kept: string[];
  removed: string[];
  skipped: string[];
}

/**
 * Bounded disk: keeps the running image and one rollback, removes every other
 * release tag of this repository. Only ever touches `<repository>:r-*` tags a
 * release created, never an image any container (running or stopped, any
 * deployment) still uses, never a volume, never build cache, never `prune`.
 */
export const pruneReleaseImages = async (
  runDocker: DockerCommandRunner,
  repository: string,
  keepTags: readonly (string | null | undefined)[]
): Promise<PruneResult> => {
  const keep = new Set(keepTags.filter((tag): tag is string => typeof tag === "string"));
  const listed = (await runDocker(["image", "ls", repository, "--no-trunc", "--format", "{{.Tag}}\t{{.ID}}"])).toString("utf8")
    .split("\n").map((line) => line.trim().split("\t")).filter((row): row is [string, string] => row.length === 2 && row[0]!.startsWith(RELEASE_TAG_PREFIX));
  const used = await inUseImageIds(runDocker);
  const result: PruneResult = { kept: [], removed: [], skipped: [] };
  for (const [tag, id] of listed) {
    const ref = `${repository}:${tag}`;
    if (keep.has(ref)) { result.kept.push(ref); continue; }
    if (used.has(id)) { result.skipped.push(ref); continue; }
    try {
      await runDocker(["image", "rm", ref]);
      result.removed.push(ref);
    } catch {
      result.skipped.push(ref);
    }
  }
  return result;
};
