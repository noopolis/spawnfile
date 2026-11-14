import path from "node:path";

import type { DaimonControlCall, DaimonControlTarget } from "../../../runtime/daimon/control.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../../../runtime/daimon/contractManifest.js";
import { parseUsageLedger, USAGE_TURN_RECORD_VERSION, type UsageRecord } from "../../../runtime/usageLedger.js";
import { parseUsageRequestLedger, type UsageRequestRecord } from "../../../runtime/usageRequestLedger.js";
import type { TrialDocker } from "./docker.js";

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

/** Daimon's per-request stream sits beside the usage ledger. */
const REQUEST_LEDGER = path.posix.join(path.posix.dirname(DAIMON_GROK_TURN_USAGE_LEDGER.filePath), "requests.jsonl");

export const readRequestLedger = async (docker: TrialDocker, container: string): Promise<UsageRequestRecord[]> =>
  parseUsageRequestLedger(await docker(["exec", container, "cat", REQUEST_LEDGER]).catch(() => ""));

/**
 * A turn the engine never closed (a wall-clock or token bound killed it) has no per-turn usage row, but its
 * model requests were measured one by one. Their sum is the spend, marked incomplete so no reader takes it
 * for a closed turn's own account.
 */
export const requestUsage = (requests: readonly UsageRequestRecord[], agentId: string): UsageRecord[] => {
  if (requests.length === 0) return [];
  const sum = (key: "input" | "cached_input" | "cache_write" | "output" | "total") => requests.reduce((total, row) => total + row[key], 0);
  return [{ v: USAGE_TURN_RECORD_VERSION, agent: agentId, at: requests.at(-1)!.at, wake: requests[0]!.wake, engine: requests[0]!.engine,
    input: sum("input"), cache_read: sum("cached_input"), cache_write: sum("cache_write"), output: sum("output"), total: sum("total"),
    calls: requests.length, complete: false, notional_usd: 0 }];
};

export const readLedger = async (docker: TrialDocker, container: string): Promise<UsageRecord[]> => {
  const text = await docker(["exec", container, "cat", DAIMON_GROK_TURN_USAGE_LEDGER.filePath]).catch(() => "");
  return parseUsageLedger(text);
};

/** The agent's execution error from Daimon's availability, or null. */
export const agentExecutionError = async (call: DaimonControlCall, target: DaimonControlTarget, agentId: string): Promise<string | null> => {
  const response = await call(target, "GET", "/v2/availability").catch(() => undefined);
  if (response?.status !== 200) return null;
  const agents = (JSON.parse(response.body) as { agents?: { agent_id?: string; error?: string }[] }).agents ?? [];
  return agents.find((agent) => agent.agent_id === agentId)?.error || null;
};

/** The engine's newest session record, bounded. */
export const readTranscript = async (docker: TrialDocker, container: string, sessionsPath: string): Promise<string | null> => {
  const newest = await docker(["exec", container, "sh", "-c", 'find "$1" -name "*.jsonl" -type f -printf "%T@ %p\\n" 2>/dev/null | sort -n | tail -1 | cut -d" " -f2-', "sh", sessionsPath]).catch(() => "");
  if (!newest) return null;
  const text = await docker(["exec", container, "head", "-c", String(MAX_TRANSCRIPT_BYTES), newest]).catch(() => "");
  return text || null;
};
