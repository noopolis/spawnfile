import { USAGE_LIMIT_REASONS, type UsageLimitReason, type UsageRecord } from "../usageTypes.js";

export const USAGE_TURN_RECORD_VERSION = "noopolis.daimon.turn-usage.v1" as const;
type DaimonUsageRecord = UsageRecord & { v: typeof USAGE_TURN_RECORD_VERSION };

const USAGE_MODELS = ["grok-4.6", "grok-4.5", "grok-build"] as const;

/**
 * The additive broker fields of a `turn-usage.v1` row. Each is copied only when
 * it is a member of Daimon's closed vocabulary; a malformed optional field is
 * dropped rather than discarding the row's spend.
 */
const brokerFields = (record: Record<string, unknown>): Pick<UsageRecord,
  "turn" | "limit_reason" | "model" | "estimated_requests" | "outcome"> => ({
  ...(typeof record.turn === "string" && /^[a-f0-9]{64}$/u.test(record.turn) ? { turn: record.turn } : {}),
  ...((USAGE_LIMIT_REASONS as readonly unknown[]).includes(record.limit_reason) ? { limit_reason: record.limit_reason as UsageLimitReason } : {}),
  ...((USAGE_MODELS as readonly unknown[]).includes(record.model) ? { model: record.model as string } : {}),
  ...(Number.isSafeInteger(record.estimated_requests) && (record.estimated_requests as number) > 0 ? { estimated_requests: record.estimated_requests as number } : {}),
  ...(record.outcome === "completed" || record.outcome === "failed" ? { outcome: record.outcome } : {})
});

const NUMERIC_FIELDS = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "total",
  "calls",
  "notional_usd"
] as const;

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Parses one ledger line. Returns `null` (never throws) for: blank lines,
 * JSON that fails to parse (this is also how a torn trailing line left by a
 * crash mid-append is skipped, a truncated JSON object fails to parse the
 * same way a garbled line would), a schema version other than
 * `noopolis.daimon.turn-usage.v1`, a missing/empty string field, an `at` that
 * doesn't parse as a date, a non-boolean `complete`, or any numeric field
 * that isn't a finite, non-negative number.
 */
export const parseUsageLedgerLine = (line: string): DaimonUsageRecord | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;

  if (record.v !== USAGE_TURN_RECORD_VERSION) {
    return null;
  }
  if (
    !isNonEmptyString(record.agent)
    || !isNonEmptyString(record.wake)
    || !isNonEmptyString(record.engine)
    || !isNonEmptyString(record.at)
  ) {
    return null;
  }
  if (Number.isNaN(Date.parse(record.at))) {
    return null;
  }
  if (typeof record.complete !== "boolean") {
    return null;
  }
  for (const field of NUMERIC_FIELDS) {
    if (!isFiniteNonNegative(record[field])) {
      return null;
    }
  }

  return {
    agent: record.agent,
    at: record.at,
    cache_read: record.cache_read as number,
    cache_write: record.cache_write as number,
    calls: record.calls as number,
    complete: record.complete,
    engine: record.engine,
    input: record.input as number,
    notional_usd: record.notional_usd as number,
    output: record.output as number,
    total: record.total as number,
    v: USAGE_TURN_RECORD_VERSION,
    wake: record.wake,
    ...brokerFields(record)
  };
};

/**
 * Parses newline-delimited ledger rows, skipping malformed lines and
 * unterminated rows left by an interrupted append.
 */
export const parseUsageLedger = (text: string): DaimonUsageRecord[] =>
  text
    .split("\n")
    .map(parseUsageLedgerLine)
    .filter((record): record is DaimonUsageRecord => record !== null);
