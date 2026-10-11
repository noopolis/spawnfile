import { describe, expect, it } from "vitest";
import { composeMomentRecord, momentRecordSchema, parseMomentRecord, type ComposeMomentRecordInput, type MomentRecord } from "./index.js";

const at = "2026-10-09T08:20:31Z";
const input = (): ComposeMomentRecordInput => ({
  row: { version: "noopolis.daimon.wake-moment.v1", agent_id: "agent:writer", execution_id: "execution",
    started_at: at, deliveries: [{ acceptance_id: "accept", delivery_id: "wake", kind: "manual", occurred_at: at }], snapshots: [] },
  agentNodeId: "agent:writer", deploymentRecordPath: "/retained/deployments/desk.json", recordedAt: at,
  deployResources: [], feedLandings: {}, memoryLedgers: {}
});

describe("shared moment record contract", () => {
  it("round-trips the merged composer's output without a second consumer schema", () => {
    const record: MomentRecord = composeMomentRecord(input());
    expect(record.exact).toBe(false);
    expect(parseMomentRecord(JSON.stringify(record))).toEqual(record);
  });

  it("accepts only digest bundle pins and bounded memory cursors with optional generation", () => {
    const record = { ...composeMomentRecord(input()), resources: [{ id: "tools", kind: "bundle", sha256: `sha256:${"a".repeat(64)}` }],
      memory: [{ id: "self", declaredBy: "agent:writer", seq: 0, generation: 0 }] };
    expect(parseMomentRecord(JSON.stringify(record))).toEqual(record);
    for (const invalid of [{ ...record, resources: [{ id: "tools", kind: "bundle", commit: "a".repeat(40) }] },
      { ...record, exact: undefined }, { ...record, memory: [{ ...record.memory[0], seq: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...record, wake: { ...record.wake, deliveries: [] } }]) expect(momentRecordSchema.safeParse(invalid).success).toBe(false);
  });
});
