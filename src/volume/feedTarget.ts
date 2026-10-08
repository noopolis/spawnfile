import path from "node:path";

import type { FeedSourceSpec } from "./feedSource.js";

export const DEFAULT_FEED_KEEP = 1;
export const DEFAULT_FEED_HEAL_LIMIT = 3;
export const DEFAULT_FEED_VALIDATE_TIMEOUT_MS = 10 * 60_000;

/** Everything a refresh or verify needs, resolved from the manifest and the host. */
export interface FeedTarget {
  /** Re-lands of one revision before auto-repair is suspended. */
  healLimit: number;
  /** Retired trees kept beside the serving one, so a reader mid-read survives at least one swap. */
  keep: number;
  owner?: string;
  resourceId: string;
  source: FeedSourceSpec;
  /** Host state outside the volume, on its filesystem: record, manifests, staging, trash, lock. */
  stateDir: string;
  validate?: { command: string[]; cwd: string; timeoutMs: number };
  /** Host path of the volume's content root. */
  volume: string;
  volumeName: string;
}

export const feedStagingDir = (target: FeedTarget): string => path.join(target.stateDir, "staging");
export const feedTrashDir = (target: FeedTarget): string => path.join(target.stateDir, "trash");
