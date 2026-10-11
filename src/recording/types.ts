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

export interface MomentRecord {
  version: typeof MOMENT_RECORD_VERSION;
  agent: string;
  wake: {
    at: string;
    startedAt: string;
    executionId: string;
    deliveries: { deliveryId: string; kind: string; occurredAt: string }[];
    surface?: "moltnet";
    messageId?: string;
  };
  recordedAt: string;
  exact: boolean;
  resources: ({ id: string; kind: "git"; commit: string; sha256?: string }
    | { id: string; kind: "bundle"; sha256: string })[];
  feeds: { id: string; revision: string; tree: string; commit?: string; ref?: string;
    paths?: string[]; landedAt: string; period?: string }[];
  memory: { id: string; declaredBy: string; seq: number }[];
  moltnet: { network: string; cursor: string; messageIds?: string[] }[];
  volumes: { id: string; snapshot: string }[];
  errors?: string[];
}
