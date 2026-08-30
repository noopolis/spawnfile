import { describe, expect, it } from "vitest";

import {
  computeUsageCoverage,
  DEFAULT_USAGE_SINCE,
  filterUsageRecordsSince,
  groupUsageByAgent,
  groupUsageByEngine,
  parseUsageLedger,
  parseUsageLedgerLine,
  parseUsageSinceDuration,
  USAGE_TURN_RECORD_VERSION,
  type UsageRecord
} from "./usageLedger.js";

const record = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
  agent: "cogsworth",
  at: "2026-08-29T01:12:04.000Z",
  cache_read: 5760,
  cache_write: 0,
  calls: 1,
  complete: true,
  engine: "grok",
  input: 8746,
  notional_usd: 0.0035,
  output: 29,
  total: 14535,
  v: USAGE_TURN_RECORD_VERSION,
  wake: "wake-1",
  ...overrides
});

const line = (overrides: Partial<UsageRecord> = {}): string => JSON.stringify(record(overrides));

describe("parseUsageLedgerLine", () => {
  it("parses a well-formed line", () => {
    expect(parseUsageLedgerLine(line())).toEqual(record());
  });

  it("returns null for a blank line", () => {
    expect(parseUsageLedgerLine("")).toBeNull();
    expect(parseUsageLedgerLine("   ")).toBeNull();
  });

  it("rejects a wrong-version line without throwing", () => {
    const malformed = JSON.stringify({ ...record(), v: "noopolis.daimon.turn-usage.v2" });
    expect(parseUsageLedgerLine(malformed)).toBeNull();
  });

  it("rejects a line with a negative or non-finite numeric field", () => {
    expect(parseUsageLedgerLine(line({ input: -1 }))).toBeNull();
    expect(parseUsageLedgerLine(JSON.stringify({ ...record(), total: Number.NaN }))).toBeNull();
    expect(parseUsageLedgerLine(JSON.stringify({ ...record(), notional_usd: Infinity }))).toBeNull();
  });

  it("rejects a line with a stringified numeric field", () => {
    expect(parseUsageLedgerLine(JSON.stringify({ ...record(), calls: "1" }))).toBeNull();
  });

  it("rejects a line missing a required string field", () => {
    const { agent: _agent, ...withoutAgent } = record();
    expect(parseUsageLedgerLine(JSON.stringify(withoutAgent))).toBeNull();
  });

  it("rejects a line with an unparseable `at`", () => {
    expect(parseUsageLedgerLine(line({ at: "not-a-date" }))).toBeNull();
  });

  it("rejects a non-object JSON value without throwing", () => {
    expect(parseUsageLedgerLine("42")).toBeNull();
    expect(parseUsageLedgerLine("[1,2,3]")).toBeNull();
    expect(parseUsageLedgerLine("null")).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(() => parseUsageLedgerLine("{not json")).not.toThrow();
    expect(parseUsageLedgerLine("{not json")).toBeNull();
  });
});

describe("parseUsageLedger", () => {
  it("skips an unterminated trailing line (a crash mid-append) and keeps the rest", () => {
    const goodLine = line({ agent: "cogsworth" });
    // A torn record: append truncated mid-object, exactly as a crash mid-write would leave it.
    const tornTail = '{"v":"noopolis.daimon.turn-usage.v1","agent":"foreman","wake":"wake-2","eng';
    const text = `${goodLine}\n${tornTail}`;

    const records = parseUsageLedger(text);

    expect(records).toHaveLength(1);
    expect(records[0]!.agent).toBe("cogsworth");
  });

  it("skips a malformed/wrong-version line but keeps parsing the rest of the file", () => {
    const text = [
      line({ agent: "cogsworth" }),
      JSON.stringify({ ...record(), v: "noopolis.daimon.turn-usage.v0" }),
      "not even json",
      line({ agent: "foreman" })
    ].join("\n");

    const records = parseUsageLedger(text);

    expect(records.map((r) => r.agent)).toEqual(["cogsworth", "foreman"]);
  });

  it("returns an empty array for empty text", () => {
    expect(parseUsageLedger("")).toEqual([]);
  });

  it("ignores blank lines between records", () => {
    const text = `${line({ agent: "cogsworth" })}\n\n${line({ agent: "foreman" })}\n`;
    expect(parseUsageLedger(text).map((r) => r.agent)).toEqual(["cogsworth", "foreman"]);
  });
});

describe("parseUsageSinceDuration", () => {
  it("parses hours, days, and minutes", () => {
    expect(parseUsageSinceDuration("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseUsageSinceDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseUsageSinceDuration("30m")).toBe(30 * 60 * 1000);
  });

  it("returns null for an unrecognized format", () => {
    expect(parseUsageSinceDuration("yesterday")).toBeNull();
    expect(parseUsageSinceDuration("24")).toBeNull();
    expect(parseUsageSinceDuration("24w")).toBeNull();
  });

  it("has a default matching the design's org-total default window", () => {
    expect(DEFAULT_USAGE_SINCE).toBe("24h");
  });
});

describe("filterUsageRecordsSince", () => {
  const now = Date.parse("2026-08-29T12:00:00.000Z");

  it("keeps records at or after the cutoff and drops older ones", () => {
    const inWindow = record({ at: "2026-08-29T06:00:00.000Z" }); // 6h ago
    const outOfWindow = record({ at: "2026-08-27T00:00:00.000Z" }); // days ago
    const records = filterUsageRecordsSince([inWindow, outOfWindow], 24 * 60 * 60 * 1000, now);
    expect(records).toEqual([inWindow]);
  });

  it("a window spanning a rotation keeps records from both generations", () => {
    // Simulates records merged from usage.jsonl.1 (rotated, older) and usage.jsonl (current).
    const rotated = record({ agent: "cogsworth", at: "2026-08-28T13:00:00.000Z" }); // 23h ago
    const current = record({ agent: "cogsworth", at: "2026-08-29T11:00:00.000Z" }); // 1h ago
    const records = filterUsageRecordsSince([rotated, current], 24 * 60 * 60 * 1000, now);
    expect(records).toHaveLength(2);
  });
});

describe("groupUsageByAgent", () => {
  it("sums turns, tokens, notional, and incomplete count per agent", () => {
    const records = [
      record({ agent: "cogsworth", complete: true, notional_usd: 1, total: 100 }),
      record({ agent: "cogsworth", complete: false, notional_usd: 2, total: 200 }),
      record({ agent: "foreman", engine: "grok", notional_usd: 3, total: 300 })
    ];

    const groups = groupUsageByAgent(records);
    const cogsworth = groups.find((g) => g.agent === "cogsworth")!;
    expect(cogsworth).toEqual({
      agent: "cogsworth",
      engine: "grok",
      incompleteTurns: 1,
      notionalUsd: 3,
      tokens: 300,
      turns: 2
    });
    expect(groups.find((g) => g.agent === "foreman")).toEqual({
      agent: "foreman",
      engine: "grok",
      incompleteTurns: 0,
      notionalUsd: 3,
      tokens: 300,
      turns: 1
    });
  });

  it("seeds a zero-usage row for a roster agent with no records (uninstrumented engine)", () => {
    const records = [record({ agent: "cogsworth" })];
    const groups = groupUsageByAgent(records, [
      { agent: "cogsworth", engine: "grok" },
      { agent: "brass", engine: "codex" }
    ]);

    expect(groups.find((g) => g.agent === "brass")).toEqual({
      agent: "brass",
      engine: "codex",
      incompleteTurns: 0,
      notionalUsd: 0,
      tokens: 0,
      turns: 0
    });
  });
});

describe("groupUsageByEngine", () => {
  it("sums per engine and seeds a zero-usage row for a known engine with no records", () => {
    const records = [
      record({ engine: "grok", notional_usd: 6.8, total: 2_100_000 }),
      record({ agent: "foreman", engine: "grok", notional_usd: 4.3, total: 1_400_000 })
    ];

    const groups = groupUsageByEngine(records, ["grok", "codex"]);

    expect(groups.find((g) => g.engine === "grok")).toEqual({
      engine: "grok",
      incompleteTurns: 0,
      notionalUsd: 11.1,
      tokens: 3_500_000,
      turns: 2
    });
    expect(groups.find((g) => g.engine === "codex")).toEqual({
      engine: "codex",
      incompleteTurns: 0,
      notionalUsd: 0,
      tokens: 0,
      turns: 0
    });
  });
});

describe("computeUsageCoverage", () => {
  it("is PARTIAL when an engine (and its agents) report nothing", () => {
    const records = [record({ agent: "cogsworth" }), record({ agent: "foreman" })];
    const coverage = computeUsageCoverage(records, 16);

    expect(coverage).toEqual({
      agentsReporting: 2,
      agentsTotal: 16,
      incompleteRecordCount: 0,
      partial: true,
      unreadableUnitCount: 0
    });
  });

  it("is not PARTIAL when every roster agent reported", () => {
    const records = [record({ agent: "cogsworth" }), record({ agent: "foreman" })];
    const coverage = computeUsageCoverage(records, 2);
    expect(coverage.partial).toBe(false);
  });

  it("is PARTIAL when a ledger could not be read at all, even with a full roster", () => {
    // Zero must be distinguishable from unknown: a unit whose ledger read
    // failed contributes no records, so a full-roster window would otherwise
    // be presented as the organization's complete cost.
    const records = [record({ agent: "cogsworth" }), record({ agent: "foreman" })];
    const coverage = computeUsageCoverage(records, 2, 1);
    expect(coverage.unreadableUnitCount).toBe(1);
    expect(coverage.partial).toBe(true);
  });

  it("counts complete:false records as a lower-bound signal", () => {
    const records = [
      record({ agent: "cogsworth", complete: true }),
      record({ agent: "cogsworth", complete: false }),
      record({ agent: "foreman", complete: false })
    ];
    expect(computeUsageCoverage(records, 2).incompleteRecordCount).toBe(2);
  });
});
