import { vi } from "vitest";
import type { RecordingAgentReport } from "../report/index.js";
import type { UsageLedgerExec } from "../runtime/usageLedgerRead.js";
import type { WakeMomentRow } from "./types.js";

export const startedAt = "2026-10-09T08:20:31.250Z";
export const now = () => new Date("2026-10-09T09:00:00.000Z");
export const agent: RecordingAgentReport = {
  node_id: "agent:writer", slug: "writer", directory: "/var/lib/spawnfile/recording/writer", keep_ms: 86_400_000,
  networks: ["news"], memory: [{ id: "self", declared_by: "agent:writer", ledger_path: "/data/self/memory/events.jsonl" }],
  resources: [], feeds: [], snapshots: ["state"]
};
export const wake = (time = startedAt, id = "moltnet:42"): WakeMomentRow => ({
  version: "noopolis.daimon.wake-moment.v1", agent_id: agent.node_id, execution_id: id, started_at: time,
  deliveries: [{ acceptance_id: "accepted-1", delivery_id: "moltnet:42", kind: "message", occurred_at: time }],
  snapshots: [{ id: "state", snapshot: `${new Date(time).toISOString().replace(/[-:.]/gu, "")}-execution-1`, files: 2, copied: 1, linked: 1, skipped: 0 }]
});

/** Enforce the gateway's byte cap, including the base64 envelope, on every request. */
export const chunkExec = (file: (path: string) => string | null, maxBuffer = 1024 * 1024): UsageLedgerExec =>
  vi.fn(async (command) => {
    if (command[0] !== "node" || command[1] !== "-e") throw new Error("Expected bounded Node reader");
    const payload = file(command[3]!);
    const bytes = payload === null ? null : Buffer.from(payload);
    const start = Number(command[4]), count = Number(command[5]);
    const stdout = JSON.stringify(bytes === null ? null : {
      size: bytes.length, identity: "1:1", data: bytes.subarray(start, start + count).toString("base64")
    });
    if (Buffer.byteLength(stdout) > maxBuffer) throw new Error("Gateway maxBuffer exceeded");
    return { stderr: "", stdout };
  });

export const execFor = (rows: WakeMomentRow[], ledger = `${JSON.stringify({ seq: 9, createdAt: startedAt })}\n`): UsageLedgerExec =>
  chunkExec((file) => file.endsWith("wake-moments.jsonl") ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n" : ledger);
