import path from "node:path";

import { deployResourcesAt, type DeployResources } from "../deployment/index.js";
import type { RecordingAgentReport } from "../report/index.js";
import type { UsageLedgerExec } from "../runtime/usageLedgerRead.js";
import type { FeedLanding } from "../volume/index.js";
import { composeMomentRecord } from "./compose.js";
import { readRecordingDeployHistory, recordingHistoryAt, type RecordingHistory } from "./history.js";
import { createMemoryLedgerParser, createWakeMomentsParser } from "./parse.js";
import { readRecordingJsonl } from "./read.js";
import { newestMomentInstant, pruneMomentRecords, withMomentStore, writeMomentRecord } from "./store.js";
import type { MemoryLedgerRead, WakeMomentRow } from "./types.js";

export interface SyncMomentRecordsOptions {
  recordPath: string;
  agents: readonly RecordingAgentReport[];
  execForAgent: (agent: RecordingAgentReport) => UsageLedgerExec;
  readFeedHistory: (feed: RecordingAgentReport["feeds"][number]) => Promise<RecordingHistory<FeedLanding>>;
  readDeployHistory?: (recordPath: string) => RecordingHistory<DeployResources> | Promise<RecordingHistory<DeployResources>>;
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
  const deploy = await (options.readDeployHistory ?? readRecordingDeployHistory)(options.recordPath);
  const deployTail = deploy.entries.at(-1);
  const deployPendingSince = deployTail ? Date.parse(deployTail.activated_at) : -Infinity;
  const currentDeployment = deployResourcesAt(deploy.entries, options.recordPath, now);
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
      const memoryCache: Record<string, MemoryLedgerRead> = Object.create(null) as Record<string, MemoryLedgerRead>;
      const feedCache = new Map<string, RecordingHistory<FeedLanding>>();
      result.warnings.push(...errors.map((error) => `${agent.node_id}: ${error}`));
      for (const [slug, rows] of rowsBySlug) await withMomentStore(options.recordPath, slug, async (directory) => {
        const newest = rows.reduce((latest, { row }) => Math.max(latest, Date.parse(row.started_at)),
          await newestMomentInstant(directory, agent.node_id));
        for (const { row, directory: sourceDirectory } of rows) {
          const started = Date.parse(row.started_at);
          // Do not recreate already-pruned attempts on every sync while Daimon retains its row log.
          if (started < now.getTime() - agent.keep_ms && started < newest) { result.skipped += 1; continue; }
          const { agent: historical, deployment } = recordingHistoryAt(deploy.entries, options.recordPath, row.started_at, agent.node_id);
          const rowErrors = [...errors];
          if (deploy.publicationPending && started >= deployPendingSince) rowErrors.push("Deploy history publication pending");
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
            const tail = history.entries.at(-1);
            const pendingSince = tail ? Date.parse(tail.landed_at) : -Infinity;
            if (history.publicationPending && started >= pendingSince) rowErrors.push(`Feed ${feed.id}: history publication pending`);
            rowErrors.push(...history.errors.map((error) => `Feed ${feed.id}: ${error}`));
          }
          const memoryLedgers: Record<string, MemoryLedgerRead> = Object.create(null) as Record<string, MemoryLedgerRead>;
          for (const bank of historical?.memory ?? []) {
            if (bank.ledger_path === null) continue;
            const current = agent.memory.some((entry) => entry.id === bank.id && entry.declared_by === bank.declared_by
              && entry.ledger_path === bank.ledger_path);
            // Older facts do not carry a physical volume ID. A different report cannot
            // establish that today's readable path still names the historical bank.
            if (!current || deployment?.report_sha256 !== currentDeployment?.report_sha256) {
              memoryLedgers[bank.ledger_path] = { entries: [], errors: ["Historical bank identity or mount cannot be verified in the current deployment"] };
              continue;
            }
            if (!memoryCache[bank.ledger_path]) {
              const ledger = await readRecordingJsonl(exec, bank.ledger_path, createMemoryLedgerParser(), options.readChunkBytes);
              memoryCache[bank.ledger_path] = ledger.failure || ledger.missing
                ? { entries: [], errors: [`Ledger unreadable: ${ledger.failure ?? "runtime file is absent"}`] } : ledger;
            }
            memoryLedgers[bank.ledger_path] = memoryCache[bank.ledger_path]!;
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
