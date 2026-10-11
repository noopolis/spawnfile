import path from "node:path";

import { readDeployResources, type DeployResources } from "../deployment/resourceLog.js";
import type { RecordingAgentReport } from "../report/index.js";
import { readRuntimeFileViaExec, type UsageLedgerExec } from "../runtime/usageLedgerRead.js";
import type { FeedLanding } from "../volume/index.js";
import { composeMomentRecord } from "./compose.js";
import { parseMemoryLedger, parseWakeMoments } from "./parse.js";
import { newestMomentInstant, pruneMomentRecords, withMomentStore, writeMomentRecord } from "./store.js";
import type { MemoryLedgerRead, RecordingAgentFacts } from "./types.js";

interface History<T> { entries: T[]; errors: string[] }
export interface SyncMomentRecordsOptions {
  recordPath: string;
  agents: readonly RecordingAgentReport[];
  execForAgent: (agent: RecordingAgentReport) => UsageLedgerExec;
  readFeedHistory: (feed: RecordingAgentReport["feeds"][number]) => Promise<History<FeedLanding>>;
  readDeployHistory?: (recordPath: string) => History<DeployResources>;
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

const compiledFacts = (agent: RecordingAgentReport): RecordingAgentFacts => ({
  nodeId: agent.node_id, slug: agent.slug, networks: agent.networks,
  memory: agent.memory.map((bank) => ({ id: bank.id, declaredBy: bank.declared_by, ledgerPath: bank.ledger_path })),
  feeds: agent.feeds.map((feed) => feed.id), resources: agent.resources, snapshots: agent.snapshots
});

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
      const read = await readRuntimeFileViaExec(exec, path.posix.join(agent.directory, "wake-moments.jsonl"));
      if (read.failure) throw new Error(`Wake moments unreadable: ${read.failure.reason}`);
      const wake = parseWakeMoments(read.text);
      const errors = [...deploy.errors.map((error) => `Deploy history: ${error}`), ...wake.errors];
      for (const row of wake.entries) {
        if (row.agent_id !== agent.node_id) errors.push(`Foreign wake row for ${row.agent_id}`);
      }
      const feedLandings: Record<string, FeedLanding[]> = Object.create(null) as Record<string, FeedLanding[]>;
      for (const feed of agent.feeds) {
        try {
          const history = await options.readFeedHistory(feed);
          // A neighboring/foreign volume log is not evidence for this compiled feed.
          feedLandings[feed.id] = history.entries.filter((entry) => entry.resource === feed.id && entry.volume === feed.volume_name);
          errors.push(...history.errors.map((error) => `Feed ${feed.id}: ${error}`));
        } catch {
          errors.push(`Feed ${feed.id}: cannot resolve or read host landing history for volume ${feed.volume_name}`);
        }
      }
      const memoryLedgers: Record<string, MemoryLedgerRead> = {};
      for (const bank of agent.memory) {
        if (bank.ledger_path === null || memoryLedgers[bank.ledger_path] !== undefined) continue;
        const ledger = await readRuntimeFileViaExec(exec, bank.ledger_path);
        memoryLedgers[bank.ledger_path] = ledger.failure
          ? { entries: [], errors: [`Ledger unreadable: ${ledger.failure.reason}`] }
          : parseMemoryLedger(ledger.text);
      }
      result.warnings.push(...errors.map((error) => `${agent.node_id}: ${error}`));
      await withMomentStore(options.recordPath, agent.slug, async (directory) => {
        const rows = wake.entries.filter((row) => row.agent_id === agent.node_id);
        const newest = rows.reduce((latest, row) => Math.max(latest, Date.parse(row.started_at)),
          await newestMomentInstant(directory, agent.node_id));
        for (const row of rows) {
          const started = Date.parse(row.started_at);
          // Do not recreate already-pruned attempts on every sync while Daimon retains its row log.
          if (started < now.getTime() - agent.keep_ms && started < newest) { result.skipped += 1; continue; }
          const record = composeMomentRecord({ row, agent: compiledFacts(agent), deploymentRecordPath: options.recordPath,
            feedLandings, deployResources: deploy.entries, memoryLedgers, errors, recordedAt: now.toISOString() });
          if (await writeMomentRecord(directory, record)) {
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
