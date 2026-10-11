import path from "node:path";

import { readDeployResources, type DeployResources } from "../deployment/resourceLog.js";
import type { RecordingAgentReport } from "../report/index.js";
import type { UsageLedgerExec } from "../runtime/usageLedgerRead.js";
import type { FeedLanding } from "../volume/index.js";
import { composeMomentRecord } from "./compose.js";
import { recordingHistoryAt } from "./history.js";
import { createMemoryLedgerParser, createWakeMomentsParser } from "./parse.js";
import { readRecordingJsonl } from "./read.js";
import { newestMomentInstant, pruneMomentRecords, withMomentStore, writeMomentRecord } from "./store.js";
import type { MemoryLedgerRead, WakeMomentRow } from "./types.js";

interface History<T> { entries: T[]; errors: string[] }
export interface SyncMomentRecordsOptions {
  recordPath: string;
  agents: readonly RecordingAgentReport[];
  execForAgent: (agent: RecordingAgentReport) => UsageLedgerExec;
  readFeedHistory: (feed: RecordingAgentReport["feeds"][number]) => Promise<History<FeedLanding>>;
  readDeployHistory?: (recordPath: string) => History<DeployResources>;
  readChunkBytes?: number;
  now?: () => Date;
}
export interface SyncMomentRecordsResult {
  written: number;
  skipped: number;
  nonExact: number;
  /** Operational errors cause nonzero exit; data errors only qualify exactness. */
  failures: string[];
  warnings: string[];
}

/** Artifact egress only. No turn, snapshot copy, network-history fetch, or source resolution. */
export const syncMomentRecords = async (options: SyncMomentRecordsOptions): Promise<SyncMomentRecordsResult> => {
  const result: SyncMomentRecordsResult = { written: 0, skipped: 0, nonExact: 0, failures: [], warnings: [] };
  if (!options.agents.length) return result;
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error("Recording requires a valid clock");
  const deploy = (options.readDeployHistory ?? readDeployResources)(options.recordPath);
  for (const agent of options.agents) {
    try {
      if (!Number.isSafeInteger(agent.keep_ms) || agent.keep_ms <= 0) throw new Error("Invalid recording retention");
      const exec = options.execForAgent(agent);
      const directories = new Set([agent.directory, ...deploy.entries
        .filter((entry) => entry.deployment_id === path.resolve(options.recordPath))
        .flatMap((entry) => entry.recording_agents ?? []).filter((entry) => entry.node_id === agent.node_id)
        .map((entry) => entry.directory)]);
      const errors = deploy.errors.map((error) => `Deploy history: ${error}`);
      const rowsBySlug = new Map<string, { row: WakeMomentRow; directory: string }[]>();
      rowsBySlug.set(agent.slug, []);
      for (const directory of directories) {
        // Retention still runs when a log has become empty since the previous sync.
        rowsBySlug.set(path.posix.basename(directory), rowsBySlug.get(path.posix.basename(directory)) ?? []);
        const wake = await readRecordingJsonl(exec, path.posix.join(directory, "wake-moments.jsonl"), createWakeMomentsParser(), options.readChunkBytes);
        if (wake.failure) throw new Error(`Wake moments unreadable: ${wake.failure}`);
        errors.push(...wake.errors);
        for (const row of wake.entries) {
          if (row.agent_id !== agent.node_id) { errors.push(`Foreign wake row for ${row.agent_id}`); continue; }
          const historical = recordingHistoryAt(deploy.entries, options.recordPath, row.started_at, agent.node_id).agent;
          const slug = historical?.slug ?? agent.slug;
          const rows = rowsBySlug.get(slug) ?? [];
          rows.push({ row, directory }); rowsBySlug.set(slug, rows);
        }
      }
      const memoryLedgers: Record<string, MemoryLedgerRead> = Object.create(null) as Record<string, MemoryLedgerRead>;
      const feedCache = new Map<string, History<FeedLanding>>();
      result.warnings.push(...errors.map((error) => `${agent.node_id}: ${error}`));
      for (const [slug, rows] of rowsBySlug) await withMomentStore(options.recordPath, slug, async (directory) => {
        const newest = rows.reduce((latest, { row }) => Math.max(latest, Date.parse(row.started_at)),
          await newestMomentInstant(directory, agent.node_id));
        for (const { row, directory: sourceDirectory } of rows) {
          const started = Date.parse(row.started_at);
          // Do not recreate already-pruned attempts on every sync while Daimon retains its row log.
          if (started < now.getTime() - agent.keep_ms && started < newest) { result.skipped += 1; continue; }
          const historical = recordingHistoryAt(deploy.entries, options.recordPath, row.started_at, agent.node_id).agent;
          const rowErrors = [...errors];
          if (historical && historical.directory !== sourceDirectory) rowErrors.push("Wake row directory differs from activation recording facts");
          const feedLandings: Record<string, FeedLanding[]> = Object.create(null) as Record<string, FeedLanding[]>;
          for (const feed of historical?.feeds ?? []) {
            const key = JSON.stringify([feed.id, feed.volume_name]);
            if (!feedCache.has(key)) {
              try { feedCache.set(key, await options.readFeedHistory(feed)); }
              catch { feedCache.set(key, { entries: [], errors: [`cannot resolve or read host landing history for volume ${feed.volume_name}`] }); }
            }
            const history = feedCache.get(key)!;
            feedLandings[feed.id] = history.entries.filter((entry) => entry.resource === feed.id && entry.volume === feed.volume_name);
            rowErrors.push(...history.errors.map((error) => `Feed ${feed.id}: ${error}`));
          }
          for (const bank of historical?.memory ?? []) {
            if (bank.ledger_path === null || memoryLedgers[bank.ledger_path] !== undefined) continue;
            const ledger = await readRecordingJsonl(exec, bank.ledger_path, createMemoryLedgerParser(), options.readChunkBytes);
            memoryLedgers[bank.ledger_path] = ledger.failure
              ? { entries: [], errors: [`Ledger unreadable: ${ledger.failure}`] } : ledger;
          }
          const record = composeMomentRecord({ row, agentNodeId: agent.node_id, deploymentRecordPath: options.recordPath,
            feedLandings, deployResources: deploy.entries, memoryLedgers, errors: rowErrors, recordedAt: now.toISOString() });
          if (await writeMomentRecord(directory, record, row)) {
            result.written += 1;
            if (!record.exact) result.nonExact += 1;
          } else result.skipped += 1;
        }
        await pruneMomentRecords(directory, agent.node_id, now, agent.keep_ms);
      });
    } catch (error) {
      result.failures.push(`${agent.node_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
};
