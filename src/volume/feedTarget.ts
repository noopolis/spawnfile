import path from "node:path";

import type { FeedSourceSpec } from "./feedSource.js";

export const DEFAULT_FEED_KEEP = 1;
export const DEFAULT_FEED_HEAL_LIMIT = 3;
export const DEFAULT_FEED_VALIDATE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_FEED_PREPARE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_FEED_REF_COMMAND_TIMEOUT_MS = 60_000;

/** A command run inside the staged tree before validation: in a digest-pinned image on `platform`, or on the host. */
export type FeedPrepare =
  | { command: string[]; dockerCommand: string; image: string; kind: "image"; network: boolean; platform: string; timeoutMs: number }
  | { command: string[]; kind: "host"; timeoutMs: number };

/** A git ref resolved per refresh: a template expanded at the host clock, or a command printing a ref. */
export interface FeedRefRule {
  command?: { argv: string[]; cwd: string; timeoutMs: number };
  fallback?: string;
  template?: string;
}

/** Everything a refresh or verify needs, resolved from the manifest and the host. */
export interface FeedTarget {
  /** Once local time passes `after`, a volume that already landed this period's ref stops advancing. */
  freeze?: { after: string; timezone: string };
  /** Re-lands of one revision before auto-repair is suspended. */
  healLimit: number;
  /** Host directories copied into the staged tree at `to` (tree-relative) before `prepare`. */
  include?: Array<{ from: string; to: string }>;
  /** Retired trees kept beside the serving one, so a reader mid-read survives at least one swap. */
  keep: number;
  owner?: string;
  prepare?: FeedPrepare;
  /** Replaces `source.ref` of a git source with a ref chosen on every refresh. */
  refRule?: FeedRefRule;
  resourceId: string;
  source: FeedSourceSpec;
  /** Host state outside the volume, on its filesystem: record, manifests, staging, trash, lock, prepare cache. */
  stateDir: string;
  validate?: { command: string[]; cwd: string; timeoutMs: number };
  /** Host path of the volume's content root. */
  volume: string;
  volumeName: string;
}

export const feedStagingDir = (target: FeedTarget): string => path.join(target.stateDir, "staging");
export const feedTrashDir = (target: FeedTarget): string => path.join(target.stateDir, "trash");
export const feedPreparedDir = (target: FeedTarget): string => path.join(target.stateDir, "prepared");
