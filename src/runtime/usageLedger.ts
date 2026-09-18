/**
 * Pure reader/aggregator for Daimon's per-turn usage ledger
 * (`noopolis.daimon.turn-usage.v1`, see `specs/USAGE_ACCOUNTING_DESIGN.md`). This
 * module never touches Docker, the filesystem, or a deployment record — it
 * only knows how to parse ledger text and window/group already-parsed
 * records. The transport (deciding whether to `docker exec` or fall back to
 * volume egress, and where the ledger actually lives) is a CLI-layer concern
 * in `src/cli/usageCommandLive.ts`, which composes this module with
 * `src/deployment`'s docker probe gateway and volume-egress helpers. Keeping
 * that composition out of this folder avoids a value-level import cycle:
 * `src/deployment` already imports real (non-type) exports from this folder
 * (`dockerManager.ts`'s `resolveNoopolisRunId`), so this folder must not
 * import real exports back from `src/deployment`.
 *
 * The read transport itself (`readUsageLedgerViaExec`, and the rule for when
 * a failed `cat` means "empty" versus "unknown") lives beside this file in
 * `usageLedgerRead.ts`, so this module performs no I/O at all.
 */

export const USAGE_TURN_RECORD_VERSION = "noopolis.daimon.turn-usage.v1" as const;

/** One parsed, validated line from the usage ledger. */
export interface UsageRecord {
  agent: string;
  at: string;
  cache_read: number;
  cache_write: number;
  calls: number;
  complete: boolean;
  engine: string;
  input: number;
  notional_usd: number;
  output: number;
  total: number;
  v: typeof USAGE_TURN_RECORD_VERSION;
  wake: string;
  /** Broker rows: the sha256 turn id every reader dedupes on (a replay may re-append a sealed row). */
  turn?: string;
  /** Broker rows: which per-turn limit ended the turn (`none` when none did). */
  limit_reason?: UsageLimitReason;
  /** Broker rows: the declared model the broker verified the turn ran. */
  model?: string;
  /** Broker rows: requests charged a conservative estimate because the provider response carried no valid usage. */
  estimated_requests?: number;
  outcome?: "completed" | "failed";
}

export const USAGE_LIMIT_REASONS = ["tokens", "requests", "timeout", "none"] as const;
export type UsageLimitReason = typeof USAGE_LIMIT_REASONS[number];
const USAGE_MODELS = ["grok-4.6", "grok-4.5", "grok-build"] as const;

/**
 * The additive broker fields of a `turn-usage.v1` row. Each is copied only when
 * it is a member of Daimon's closed vocabulary; a malformed optional field is
 * dropped rather than discarding the row's spend.
 */
const brokerFields = (record: Record<string, unknown>): Partial<UsageRecord> => ({
  ...(typeof record.turn === "string" && /^[a-f0-9]{64}$/u.test(record.turn) ? { turn: record.turn } : {}),
  ...((USAGE_LIMIT_REASONS as readonly unknown[]).includes(record.limit_reason) ? { limit_reason: record.limit_reason as UsageLimitReason } : {}),
  ...((USAGE_MODELS as readonly unknown[]).includes(record.model) ? { model: record.model as string } : {}),
  ...(Number.isSafeInteger(record.estimated_requests) && (record.estimated_requests as number) > 0 ? { estimated_requests: record.estimated_requests as number } : {}),
  ...(record.outcome === "completed" || record.outcome === "failed" ? { outcome: record.outcome } : {})
});

/**
 * Keeps the first row of every `turn` and every row without one.
 *
 * Daimon's broker seals a turn's ledger bytes into the turn record and appends
 * them again on replay when it cannot see the row, so two replays of one sealed
 * turn can both append identical bytes. The key exists precisely so such a turn
 * is never counted twice; every aggregate here must see deduplicated rows.
 * Readers keep every parsed row so {@link findConflictingUsageTurns} can see
 * rows that share a key but differ.
 */
export const dedupeUsageRecordsByTurn = (records: UsageRecord[]): UsageRecord[] => {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (record.turn === undefined) return true;
    if (seen.has(record.turn)) return false;
    seen.add(record.turn);
    return true;
  });
};

const canonicalRecord = (record: UsageRecord): string =>
  JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key as keyof UsageRecord]]));

/**
 * `turn` keys whose rows are not byte-for-byte the same record. A replay
 * re-appends identical sealed bytes, so differing rows under one key mean the
 * ledger is not what the broker sealed; the first row is still the one counted,
 * but the window is reported PARTIAL and the keys are named.
 */
export const findConflictingUsageTurns = (records: UsageRecord[]): string[] => {
  const first = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const record of records) {
    if (record.turn === undefined) continue;
    const canonical = canonicalRecord(record);
    const seen = first.get(record.turn);
    if (seen === undefined) first.set(record.turn, canonical);
    else if (seen !== canonical) conflicts.add(record.turn);
  }
  return [...conflicts].sort();
};

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
 * crash mid-append is skipped — a truncated JSON object fails to parse the
 * same way a garbled line would), a schema version other than
 * `noopolis.daimon.turn-usage.v1`, a missing/empty string field, an `at` that
 * doesn't parse as a date, a non-boolean `complete`, or any numeric field
 * that isn't a finite, non-negative number.
 */
export const parseUsageLedgerLine = (line: string): UsageRecord | null => {
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
 * Parses a newline-delimited ledger file. Never throws: an unparseable line —
 * including an unterminated trailing line left by a crash mid-append — is
 * skipped, and the rest of the file still parses.
 */
export const parseUsageLedger = (text: string): UsageRecord[] =>
  text
    .split("\n")
    .map(parseUsageLedgerLine)
    .filter((record): record is UsageRecord => record !== null);

const DURATION_UNIT_MS: Record<string, number> = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000
};

/** The default window `spawnfile usage` uses when `--since` is omitted. */
export const DEFAULT_USAGE_SINCE = "24h";

/** Parses a duration like `"24h"`, `"7d"`, or `"30m"` into milliseconds.
 * Returns `null` for anything else — the caller is responsible for turning
 * that into a user-facing input error. */
export const parseUsageSinceDuration = (input: string): number | null => {
  const match = /^(\d+)(h|d|m)$/u.exec(input.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = match[2]!;
  return amount * DURATION_UNIT_MS[unit]!;
};

/** Keeps only records at or after `now - sinceMs`. `now` defaults to the real
 * clock; tests pass a fixed value. */
export const filterUsageRecordsSince = (
  records: UsageRecord[],
  sinceMs: number,
  now: number = Date.now()
): UsageRecord[] => {
  const cutoff = now - sinceMs;
  return records.filter((record) => Date.parse(record.at) >= cutoff);
};

/** A roster entry: one agent the org compiled, and the engine it was
 * assigned — independent of whether it ever produced a usage record (a
 * Codex-engine agent is uninstrumented and will never appear in the ledger,
 * but still belongs in the roster so coverage/grouping can show it with
 * zeroes rather than silently omitting it). */
export interface UsageRosterEntry {
  agent: string;
  /** `null` when the roster source cannot name the agent's engine — a
   * deployment record lists agents but not engine assignment, so the engine is
   * learned from the agent's own ledger records and stays `null` for an agent
   * that never reports. */
  engine: string | null;
}

export interface UsageAgentGroup {
  agent: string;
  engine: string | null;
  /** Requests charged an estimate (no provider-reported usage); their tokens are a conservative charge, not a measurement. */
  estimatedRequests: number;
  estimatedTurns: number;
  incompleteTurns: number;
  notionalUsd: number;
  tokens: number;
  turns: number;
}

const emptyAgentGroup = (agent: string, engine: string | null): UsageAgentGroup => ({
  agent,
  engine,
  estimatedRequests: 0,
  estimatedTurns: 0,
  incompleteTurns: 0,
  notionalUsd: 0,
  tokens: 0,
  turns: 0
});

/** Groups records by agent. `roster`, when supplied, seeds a zero-usage row
 * for every known agent (so an uninstrumented engine's agents still show up
 * with dashes instead of vanishing from the table). */
export const groupUsageByAgent = (
  records: UsageRecord[],
  roster: UsageRosterEntry[] = []
): UsageAgentGroup[] => {
  const byAgent = new Map<string, UsageAgentGroup>();
  for (const entry of roster) {
    byAgent.set(entry.agent, emptyAgentGroup(entry.agent, entry.engine));
  }
  for (const record of dedupeUsageRecordsByTurn(records)) {
    const existing = byAgent.get(record.agent) ?? emptyAgentGroup(record.agent, record.engine);
    existing.turns += 1;
    existing.estimatedRequests += record.estimated_requests ?? 0;
    if (record.estimated_requests !== undefined) existing.estimatedTurns += 1;
    existing.tokens += record.total;
    existing.notionalUsd += record.notional_usd;
    if (!record.complete) {
      existing.incompleteTurns += 1;
    }
    if (existing.engine === null) {
      existing.engine = record.engine;
    }
    byAgent.set(record.agent, existing);
  }
  return [...byAgent.values()];
};

export interface UsageEngineGroup {
  engine: string;
  estimatedRequests: number;
  estimatedTurns: number;
  incompleteTurns: number;
  notionalUsd: number;
  tokens: number;
  turns: number;
}

const emptyEngineGroup = (engine: string): UsageEngineGroup => ({
  engine,
  estimatedRequests: 0,
  estimatedTurns: 0,
  incompleteTurns: 0,
  notionalUsd: 0,
  tokens: 0,
  turns: 0
});

/** Groups records by engine. `engines`, when supplied, seeds a zero-usage row
 * for every known engine (so Codex — uninstrumented — shows up as a dashed
 * row rather than being absent from the rollup). */
export const groupUsageByEngine = (
  records: UsageRecord[],
  engines: string[] = []
): UsageEngineGroup[] => {
  const byEngine = new Map<string, UsageEngineGroup>();
  for (const engine of engines) {
    byEngine.set(engine, emptyEngineGroup(engine));
  }
  for (const record of dedupeUsageRecordsByTurn(records)) {
    const existing = byEngine.get(record.engine) ?? emptyEngineGroup(record.engine);
    existing.turns += 1;
    existing.estimatedRequests += record.estimated_requests ?? 0;
    if (record.estimated_requests !== undefined) existing.estimatedTurns += 1;
    existing.tokens += record.total;
    existing.notionalUsd += record.notional_usd;
    if (!record.complete) {
      existing.incompleteTurns += 1;
    }
    byEngine.set(record.engine, existing);
  }
  return [...byEngine.values()];
};

export interface UsageCoverage {
  agentsReporting: number;
  agentsTotal: number;
  /** `turn` keys carrying differing rows (first row counted); nonzero forces `partial`. */
  conflictingTurnCount: number;
  /** Turns whose total includes an estimated charge for at least one request. */
  estimatedTurnCount: number;
  /** Count of `complete:false` records in the window — every count here is a
   * lower bound regardless of this number (see module doc / design
   * "Verification" — grok's `streaming-messages-json` carries no
   * completeness marker for a partially zero-filled turn), but a nonzero
   * count is at least a partial, observable signal of it. */
  incompleteRecordCount: number;
  /** True when at least one roster agent produced zero records in the
   * window, or when at least one ledger could not be read — the resulting
   * total must be labelled PARTIAL and never presented as the org's full
   * cost. */
  partial: boolean;
  /** Ledgers (units or rotated generations) whose read failed outright. Zero
   * records from an unreadable ledger is UNKNOWN usage, not free usage, so a
   * nonzero count here forces `partial` regardless of the roster. */
  unreadableUnitCount: number;
}

/** Coverage is computed against `totalAgents` (the full org roster size), not
 * against however many distinct agents happen to appear in `records` — an
 * uninstrumented engine's agents must count toward the shortfall, not
 * disappear from the denominator. */
export const computeUsageCoverage = (
  records: UsageRecord[],
  totalAgents: number,
  unreadableUnitCount = 0
): UsageCoverage => {
  const unique = dedupeUsageRecordsByTurn(records);
  const reporting = new Set(unique.map((record) => record.agent)).size;
  const conflictingTurnCount = findConflictingUsageTurns(records).length;
  return {
    agentsReporting: reporting,
    agentsTotal: totalAgents,
    conflictingTurnCount,
    estimatedTurnCount: unique.filter((record) => record.estimated_requests !== undefined).length,
    incompleteRecordCount: unique.filter((record) => !record.complete).length,
    partial: reporting < totalAgents || unreadableUnitCount > 0 || conflictingTurnCount > 0,
    unreadableUnitCount
  };
};
