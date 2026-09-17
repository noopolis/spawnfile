/**
 * Pure parser for Daimon's per-model-request stream
 * (`noopolis.daimon.turn-requests.v1`, `requests.jsonl` beside the usage
 * ledger). Codex rows carry a `thread`; Grok broker rows carry the broker
 * `turn`, the declared `model`, and `usage_source` (`stream`, `upstream`, or
 * `estimated` — a conservative charge for a response without valid usage).
 * Either may carry proxy- or rollout-measured `started_at`/`ended_at`, absent
 * rather than substituted when not measured. No I/O happens here.
 */

export const USAGE_REQUEST_RECORD_VERSION = "noopolis.daimon.turn-requests.v1" as const;
export const USAGE_REQUEST_SOURCES = ["stream", "upstream", "estimated"] as const;
export type UsageRequestSource = typeof USAGE_REQUEST_SOURCES[number];

export interface UsageRequestRecord {
  agent: string;
  at: string;
  cache_write: number;
  cached_input: number;
  ended_at?: string;
  engine: string;
  fresh_input: number;
  input: number;
  model?: string;
  output: number;
  reasoning?: number;
  request: number;
  requests: number;
  started_at?: string;
  thread?: string;
  total: number;
  turn?: string;
  usage_source?: UsageRequestSource;
  v: typeof USAGE_REQUEST_RECORD_VERSION;
  wake: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/u;
const COUNTS = ["input", "cached_input", "fresh_input", "cache_write", "output", "total"] as const;
const nonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** One row, or `null` for a blank, torn, foreign-version, or malformed line. Never throws. */
export const parseUsageRequestLedgerLine = (line: string): UsageRequestRecord | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(line.trim()); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (row.v !== USAGE_REQUEST_RECORD_VERSION || !text(row.agent) || !text(row.wake) || !text(row.engine) || !text(row.at) || Number.isNaN(Date.parse(row.at))) return null;
  if (!Number.isSafeInteger(row.request) || !Number.isSafeInteger(row.requests) || (row.request as number) < 0 || (row.requests as number) < 1) return null;
  if (COUNTS.some((field) => !nonNegative(row[field]))) return null;
  if ((row.started_at !== undefined && !(text(row.started_at) && TIMESTAMP.test(row.started_at)))
    || (row.ended_at !== undefined && !(text(row.ended_at) && TIMESTAMP.test(row.ended_at)))
    || (row.usage_source !== undefined && !(USAGE_REQUEST_SOURCES as readonly unknown[]).includes(row.usage_source))
    || (row.turn !== undefined && !(typeof row.turn === "string" && /^[a-f0-9]{64}$/u.test(row.turn)))
    || (row.reasoning !== undefined && !nonNegative(row.reasoning))) return null;
  return {
    agent: row.agent, at: row.at, cache_write: row.cache_write as number, cached_input: row.cached_input as number,
    engine: row.engine, fresh_input: row.fresh_input as number, input: row.input as number, output: row.output as number,
    request: row.request as number, requests: row.requests as number, total: row.total as number,
    v: USAGE_REQUEST_RECORD_VERSION, wake: row.wake,
    ...(row.started_at === undefined ? {} : { started_at: row.started_at as string }),
    ...(row.ended_at === undefined ? {} : { ended_at: row.ended_at as string }),
    ...(text(row.model) ? { model: row.model } : {}),
    ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning as number }),
    ...(text(row.thread) ? { thread: row.thread } : {}),
    ...(row.turn === undefined ? {} : { turn: row.turn as string }),
    ...(row.usage_source === undefined ? {} : { usage_source: row.usage_source as UsageRequestSource })
  };
};

/**
 * Parses a whole stream, keeping the first row of each broker `(turn, request)`
 * pair: a replayed broker turn re-appends its sealed request rows exactly as it
 * re-appends its usage row.
 */
export const parseUsageRequestLedger = (content: string): UsageRequestRecord[] => {
  const seen = new Set<string>();
  return content.split("\n").map(parseUsageRequestLedgerLine).filter((row): row is UsageRequestRecord => {
    if (row === null) return false;
    if (row.turn === undefined) return true;
    const key = `${row.turn}:${row.request}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
