import { describe, expect, it } from "vitest";

import { parseMemoryLedger, parseWakeMoments } from "./parse.js";
import { WAKE_MOMENT_VERSION, type WakeMomentRow } from "./types.js";

const row = (): WakeMomentRow => ({
  version: WAKE_MOMENT_VERSION, agent_id: "agent:writer", execution_id: "moltnet:42",
  started_at: "2026-10-09T08:20:31.250Z",
  deliveries: [{ acceptance_id: "acceptance-1", delivery_id: "moltnet:42", kind: "message", occurred_at: "2026-10-09T10:20:30.000+02:00" }],
  snapshots: [{ id: "state", snapshot: "20261009T082031250Z-sha256-123", files: 1, copied: 1, linked: 0, skipped: 0 }]
});
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe("parseWakeMoments", () => {
  it("accepts the external v1 row shape and does not collapse attempts sharing an execution id", () => {
    const first = row(), second = { ...row(), started_at: "2026-10-09T08:20:32.250Z", error: "state: root_missing" };
    expect(parseWakeMoments(line(first) + line(second))).toEqual({ entries: [first, second], errors: [] });
  });

  it("reports invalid and torn lines alongside later valid rows with their actual line numbers", () => {
    expect(parseWakeMoments(`not json\n\n${line(row())}{\"version\":`)).toEqual({
      entries: [row()], errors: ["wake moments line 1: invalid JSON or entry", "wake moments line 2: invalid JSON or entry", "wake moments line 4: invalid JSON or entry"]
    });
  });

  it.each([
    { ...row(), version: "noopolis.daimon.wake-moment.v2" },
    { ...row(), started_at: "2026-10-09T08:20:31.250" },
    { ...row(), started_at: "2026-02-30T08:20:31.250Z" },
    { ...row(), agent_id: "" },
    { ...row(), execution_id: "" },
    { ...row(), deliveries: [] },
    { ...row(), deliveries: [{ ...row().deliveries[0], acceptance_id: undefined }] },
    { ...row(), deliveries: [{ ...row().deliveries[0], occurred_at: "2026-10-09" }] },
    { ...row(), deliveries: [{ ...row().deliveries[0], message: "private contents" }] },
    { ...row(), snapshots: [{ ...row().snapshots[0], files: -1 }] },
    { ...row(), snapshots: [{ ...row().snapshots[0], linked: 0.5 }] },
    { ...row(), snapshots: [{ ...row().snapshots[0], skipped: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...row(), snapshots: [{ ...row().snapshots[0], snapshot: "../foreign" }] },
    { ...row(), snapshots: [{ ...row().snapshots[0], id: "state/path" }] },
    { ...row(), snapshots: [row().snapshots[0], row().snapshots[0]] },
    { ...row(), snapshots: Array.from({ length: 17 }, (_, i) => ({ ...row().snapshots[0], id: `state-${i}` })) },
    { ...row(), error: "" },
    { ...row(), unknown: true },
    null, []
  ])("rejects malformed protocol entries: %#", (value) => {
    expect(parseWakeMoments(line(value))).toEqual({ entries: [], errors: ["wake moments line 1: invalid JSON or entry"] });
  });

  it("enforces Daimon's 4 MiB line bound including the newline", () => {
    const value = row();
    value.execution_id = "x".repeat(4_194_304);
    expect(parseWakeMoments(line(value))).toMatchObject({ entries: [], errors: [expect.stringContaining("line 1")] });
  });

  it("reads an empty file as no attempts", () => {
    expect(parseWakeMoments("")).toEqual({ entries: [], errors: [] });
  });
});

describe("parseMemoryLedger", () => {
  const event = { seq: 42, createdAt: "2026-10-09T10:20:31.250+02:00" };

  it("reads only cursor fields from full ledger events", () => {
    expect(parseMemoryLedger(line({ ...event, id: "memory-1", type: "memory.observed", content: { kind: "text", text: "private" } })))
      .toEqual({ entries: [event], errors: [] });
  });

  it("keeps valid entries and reports every invalid line", () => {
    expect(parseMemoryLedger(`broken\n${line(event)}${line({ seq: 43 })}`)).toEqual({ entries: [event],
      errors: ["memory ledger line 1: invalid JSON or entry", "memory ledger line 3: invalid JSON or entry"] });
  });

  it.each([
    { ...event, seq: undefined }, { ...event, seq: "42" }, { ...event, seq: 0 }, { ...event, seq: -1 },
    { ...event, seq: 1.5 }, { ...event, seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...event, createdAt: "2026-10-09T08:20:31.250" }, { ...event, createdAt: "not an instant" },
    { ...event, createdAt: "2026-02-30T08:20:31.250Z" }, null, []
  ])("does not guess invalid or missing cursor metadata: %#", (value) => {
    expect(parseMemoryLedger(line(value))).toEqual({ entries: [], errors: ["memory ledger line 1: invalid JSON or entry"] });
  });

  it("reads an absent-file empty result as an empty ledger", () => {
    expect(parseMemoryLedger("")).toEqual({ entries: [], errors: [] });
  });
});
