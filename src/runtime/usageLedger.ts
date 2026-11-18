/** Common usage rows and aggregation. Native parsers normalize raw ledger lines. */
export { parseUsageLedger, parseUsageLedgerLine, USAGE_TURN_RECORD_VERSION } from "./registry.js";

import type { UsageRecord } from "./usageTypes.js";
export { USAGE_LIMIT_REASONS } from "./usageTypes.js";
export type { UsageLimitReason, UsageRecord } from "./usageTypes.js";

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
