import type { DeployResources } from "../deployment/index.js";
import type { FeedLanding } from "../volume/index.js";

export const WAKE_MOMENT_VERSION = "noopolis.daimon.wake-moment.v1";
export const MOMENT_RECORD_VERSION = "spawnfile.moment-record.v1";

/** The public, data-only row written by Daimon before each turn attempt. */
export interface WakeMomentRow {
  version: typeof WAKE_MOMENT_VERSION;
  agent_id: string;
  execution_id: string;
  started_at: string;
  deliveries: { acceptance_id: string; delivery_id: string; kind: string; occurred_at: string }[];
  snapshots: { id: string; snapshot: string; files: number; copied: number; linked: number; skipped: number }[];
  error?: string;
}

export interface MemoryLedgerEntry { seq: number; createdAt: string }
export interface MemoryLedgerRead { entries: readonly MemoryLedgerEntry[]; errors?: readonly string[] }

export interface ComposeMomentRecordInput {
  row: WakeMomentRow;
  agentNodeId: string;
  deploymentRecordPath: string;
  feedLandings: Readonly<Record<string, readonly FeedLanding[]>>;
  deployResources: readonly DeployResources[];
  memoryLedgers: Readonly<Record<string, MemoryLedgerRead>>;
  errors?: readonly string[];
  recordedAt: string;
}

export type { MomentRecord } from "./moment.js";
