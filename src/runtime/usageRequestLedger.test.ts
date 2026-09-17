import { describe, expect, it } from "vitest";

import { parseUsageRequestLedger, parseUsageRequestLedgerLine } from "./usageRequestLedger.js";

const turn = "e".repeat(64);
const grokRow = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  v: "noopolis.daimon.turn-requests.v1", agent: "foreman", wake: "wake-1", engine: "grok", at: "2026-09-17T10:00:03.000Z",
  turn, model: "grok-4.6", request: 0, requests: 2, input: 2_800, cached_input: 2_400, fresh_input: 400, cache_write: 0,
  output: 60, total: 2_860, usage_source: "stream", started_at: "2026-09-17T10:00:01.120Z", ended_at: "2026-09-17T10:00:02.004Z",
  ...overrides
});

describe("per-request usage stream", () => {
  it("accepts Grok broker rows with timing, model, and usage source, and Codex rows without them", () => {
    expect(parseUsageRequestLedgerLine(grokRow())).toMatchObject({
      ended_at: "2026-09-17T10:00:02.004Z", model: "grok-4.6", started_at: "2026-09-17T10:00:01.120Z", turn, usage_source: "stream"
    });
    expect(parseUsageRequestLedgerLine(grokRow({ usage_source: "estimated" }))).toMatchObject({ usage_source: "estimated" });
    const codex = JSON.stringify({
      v: "noopolis.daimon.turn-requests.v1", agent: "desk", wake: "w", engine: "codex", at: "2026-09-17T10:00:00.000Z", thread: "t-1",
      request: 1, requests: 3, input: 30_000, cached_input: 28_000, fresh_input: 2_000, cache_write: 0, output: 200, reasoning: 50, total: 30_200
    });
    const parsed = parseUsageRequestLedgerLine(codex)!;
    expect(parsed).toMatchObject({ engine: "codex", reasoning: 50, thread: "t-1" });
    expect(parsed.started_at).toBeUndefined();
    expect(parsed.usage_source).toBeUndefined();
  });

  it("rejects malformed rows rather than inventing values", () => {
    for (const bad of [
      grokRow({ usage_source: "guessed" }), grokRow({ started_at: "yesterday" }), grokRow({ turn: "short" }),
      grokRow({ input: -1 }), grokRow({ requests: 0 }), grokRow({ v: "noopolis.daimon.turn-usage.v1" }), "{torn"
    ]) expect(parseUsageRequestLedgerLine(bad)).toBeNull();
  });

  it("counts a replayed broker turn's request rows once", () => {
    const content = [grokRow(), grokRow(), grokRow({ request: 1 }), grokRow({ request: 1 }), ""].join("\n");
    expect(parseUsageRequestLedger(content).map((row) => row.request)).toEqual([0, 1]);
  });
});
