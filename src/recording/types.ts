import type { DeployResources } from "../deployment/index.js";
import type { FeedLanding } from "../volume/index.js";

export const WAKE_MOMENT_VERSION = "noopolis.daimon.wake-moment.v1";
export const MOMENT_RECORD_VERSION = "spawnfile.moment-record.v1";

/** Common recording facts. The version stays in the hashed row identity. */
export interface RecordedWakeMoment {
  version: string;
  agent_id: string;
  execution_id: string;
  started_at: string;
  deliveries: { acceptance_id: string; delivery_id: string; kind: string; occurred_at: string }[];
  snapshots: { id: string; snapshot: string; files: number; copied: number; linked: number; skipped: number }[];
  error?: string;
}

/** The historical v1 wake-row wire contract. */
export interface WakeMomentRow extends RecordedWakeMoment {
  version: typeof WAKE_MOMENT_VERSION;
}

export interface MemoryLedgerEntry { seq: number; createdAt: string }
export interface MemoryLedgerRead { entries: readonly MemoryLedgerEntry[]; errors?: readonly string[] }

export interface ComposeMomentRecordInput {
  row: RecordedWakeMoment;
  agentNodeId: string;
  deploymentRecordPath: string;
  feedLandings: Readonly<Record<string, readonly FeedLanding[]>>;
  deployResources: readonly DeployResources[];
  memoryLedgers: Readonly<Record<string, MemoryLedgerRead>>;
  errors?: readonly string[];
  recordedAt: string;
}

export type { MomentRecord } from "./moment.js";
