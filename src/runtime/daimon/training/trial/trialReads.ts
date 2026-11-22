import path from "node:path";

import type { TrialDocker } from "../../../../compiler/training/trial/index.js";
import {
  parseUsageLedger, parseUsageRequestLedger, USAGE_TURN_RECORD_VERSION, type UsageRecord, type UsageRequestRecord
} from "../../../index.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER, type DaimonControlCall, type DaimonControlTarget } from "../../index.js";

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
/** A wake and the continued turns it may start; Daimon caps a continuation chain at three links. */
const MAX_TRANSCRIPT_FILES = 4;

/** Daimon's per-request stream sits beside the usage ledger. */
const REQUEST_LEDGER = path.posix.join(path.posix.dirname(DAIMON_GROK_TURN_USAGE_LEDGER.filePath), "requests.jsonl");

export const readRequestLedger = async (docker: TrialDocker, container: string): Promise<UsageRequestRecord[]> => {
  const text = await docker(["exec", container, "cat", REQUEST_LEDGER], { preserveWhitespace: true }).catch(() => "");
  const lastComplete = text.lastIndexOf("\n");
  return lastComplete < 0 ? [] : parseUsageRequestLedger(text.slice(0, lastComplete));
};

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

/** The agent's queue is settled: nothing runs and no delivery waits that is not deferred. */
export const agentSettled = async (call: DaimonControlCall, target: DaimonControlTarget, agentId: string): Promise<boolean> => {
  const response = await call(target, "GET", "/v2/availability").catch(() => undefined);
  if (response?.status !== 200) return true;
  const agent = (JSON.parse(response.body) as { agents?: { agent_id?: string; pending?: number; running?: boolean; deferred?: number }[] }).agents?.find((entry) => entry.agent_id === agentId);
  return agent === undefined || (!agent.running && (agent.pending ?? 0) - (agent.deferred ?? 0) <= 0);
};

/**
 * The engine's session records written since `sinceMs`, oldest first, each bounded: one per turn when the agent
 * continued its work in fresh turns. Without any, the newest record, as before.
 */
export const readTranscript = async (docker: TrialDocker, container: string, sessionsPath: string, sinceMs = Number.POSITIVE_INFINITY): Promise<string | null> => {
  const listing = await docker(["exec", container, "sh", "-c", 'find "$1" -name "*.jsonl" -type f -printf "%T@ %p\\n" 2>/dev/null | sort -n', "sh", sessionsPath]).catch(() => "");
  const files = listing.split("\n").filter(Boolean).map((line) => ({ at: Number(line.slice(0, line.indexOf(" "))) * 1000, file: line.slice(line.indexOf(" ") + 1) }));
  if (files.length === 0) return null;
  const recent = files.filter((entry) => entry.at >= sinceMs);
  const chosen = (recent.length > 0 ? recent : files.slice(-1)).slice(-MAX_TRANSCRIPT_FILES);
  const texts = await Promise.all(chosen.map(async (entry) => await docker(["exec", container, "head", "-c", String(MAX_TRANSCRIPT_BYTES), entry.file]).catch(() => "")));
  const text = texts.filter(Boolean).map((value) => value.endsWith("\n") ? value : `${value}\n`).join("");
  return text || null;
};
