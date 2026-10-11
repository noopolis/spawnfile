import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordingAgentReport } from "../report/index.js";
import type { UsageLedgerExec } from "../runtime/usageLedgerRead.js";
import { deploymentMomentsDirectory, momentFileName } from "./store.js";
import { syncMomentRecords } from "./sync.js";
import type { MomentRecord, WakeMomentRow } from "./types.js";

const startedAt = "2026-10-09T08:20:31.250Z";
const now = () => new Date("2026-10-09T09:00:00.000Z");
const agent: RecordingAgentReport = {
  node_id: "agent:writer", slug: "writer", directory: "/var/lib/spawnfile/recording/writer", keep_ms: 86_400_000,
  networks: ["news"], memory: [{ id: "self", declared_by: "agent:writer", ledger_path: "/data/self/memory/events.jsonl" }],
  resources: [], feeds: [], snapshots: ["state"]
};
const wake = (time = startedAt, id = "moltnet:42"): WakeMomentRow => ({
  version: "noopolis.daimon.wake-moment.v1", agent_id: agent.node_id, execution_id: id, started_at: time,
  deliveries: [{ acceptance_id: "accepted-1", delivery_id: "moltnet:42", kind: "message", occurred_at: time }],
  snapshots: [{ id: "state", snapshot: `${new Date(time).toISOString().replace(/[-:.]/gu, "")}-execution-1`, files: 2, copied: 1, linked: 1, skipped: 0 }]
});
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "record-sync-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const recordPath = () => path.join(root, "news.json");
const directory = () => path.join(deploymentMomentsDirectory(recordPath()), "writer");
const records = async (): Promise<MomentRecord[]> => Promise.all((await readdir(directory())).filter((name) => name.endsWith(".json"))
  .map(async (name) => JSON.parse(await readFile(path.join(directory(), name), "utf8")) as MomentRecord));
const execFor = (rows: WakeMomentRow[], ledger = `${JSON.stringify({ seq: 9, createdAt: startedAt })}\n`): UsageLedgerExec =>
  vi.fn(async (command) => ({ stderr: "", stdout: command[1]!.endsWith("wake-moments.jsonl")
    ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n" : ledger }));
const run = (exec: UsageLedgerExec, extra = {}) => syncMomentRecords({
  recordPath: recordPath(), agents: [agent], execForAgent: () => exec, readFeedHistory: async () => ({ entries: [], errors: [] }), now, ...extra
});

describe("syncMomentRecords", () => {
  it("reads through cat, publishes private records, and never rewrites them on a second sync", async () => {
    const exec = execFor([wake()]);
    expect(await run(exec)).toMatchObject({ written: 1, skipped: 0, nonExact: 0, failures: [] });
    const file = path.join(directory(), momentFileName(startedAt, "moltnet:42"));
    const before = await readFile(file, "utf8"), metadata = await stat(file);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(exec).toHaveBeenCalledWith(["cat", "/data/self/memory/events.jsonl"]);
    expect(JSON.parse(before)).toMatchObject({ exact: true, memory: [{ seq: 9 }], recordedAt: now().toISOString() });
    expect(await run(exec, { now: () => new Date("2026-10-09T10:00:00Z") })).toMatchObject({ written: 0, skipped: 1 });
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(metadata.mtimeMs);
    expect((await readdir(directory())).some((name) => name.includes(".tmp") || name.endsWith(".lock"))).toBe(false);
  });

  it("gives replay attempts with one execution id separate filenames", async () => {
    expect(await run(execFor([wake(), wake("2026-10-09T08:21:31.250Z")]))).toMatchObject({ written: 2 });
    expect(await records()).toHaveLength(2);
  });

  it("prunes expired files, retains the inclusive boundary, and does not recreate pruned rows", async () => {
    const rows = [wake("2026-10-08T08:00:00Z", "old"), wake("2026-10-08T09:00:00Z", "boundary"), wake()];
    await run(execFor(rows), { now: () => new Date("2026-10-08T09:00:00Z") });
    expect(await records()).toHaveLength(3);
    await run(execFor(rows));
    expect((await records()).map((record) => record.wake.executionId).sort()).toEqual(["boundary", "moltnet:42"]);
    expect(await run(execFor(rows))).toMatchObject({ written: 0, skipped: 3 });
  });

  it("keeps the newest per agent even when every attempt is older than keep", async () => {
    const rows = [wake("2026-10-01T00:00:00Z", "older"), wake("2026-10-02T00:00:00Z", "newest")];
    await run(execFor(rows));
    expect((await records()).map((record) => record.wake.executionId)).toEqual(["newest"]);
    expect(await run(execFor(rows))).toMatchObject({ written: 0, skipped: 2 });
  });

  it("unreadable memory is non-exact, while an absent memory file is successfully empty", async () => {
    const unreadable: UsageLedgerExec = async (command) => {
      if (command[1]!.endsWith("wake-moments.jsonl")) return { stdout: JSON.stringify(wake()), stderr: "" };
      throw Object.assign(new Error("permission denied"), { code: 1 });
    };
    expect(await run(unreadable)).toMatchObject({ written: 1, nonExact: 1, failures: [] });
    expect((await records())[0]).toMatchObject({ exact: false, errors: [expect.stringContaining("unreadable")] });
    const absent: UsageLedgerExec = async (command) => {
      if (command[1]!.endsWith("wake-moments.jsonl")) return { stdout: JSON.stringify(wake("2026-10-09T08:22:00Z", "new")), stderr: "" };
      throw Object.assign(new Error("cat: no such file or directory"), { code: 1 });
    };
    expect(await run(absent)).toMatchObject({ written: 1, nonExact: 0, failures: [] });
    expect((await records()).find((record) => record.wake.executionId === "new")?.memory).toEqual([{ id: "self", declaredBy: agent.node_id, seq: 0 }]);
  });

  it("reports failed wake reads as operational failures and absent wake files as empty", async () => {
    expect(await run(async () => { throw Object.assign(new Error("docker: no such file or directory"), { code: "ENOENT" }); }))
      .toMatchObject({ written: 0, failures: [expect.stringContaining("unreadable")] });
    expect(await run(async () => { throw Object.assign(new Error("cat: no such file or directory"), { code: 1 }); }))
      .toMatchObject({ written: 0, failures: [] });
  });

  it("propagates corrupt lines and unresolved feed histories without aborting records", async () => {
    const exec: UsageLedgerExec = async (command) => ({ stderr: "", stdout: command[1]!.endsWith("wake-moments.jsonl")
      ? `${JSON.stringify(wake())}\nbad line\n` : "" });
    const result = await run(exec, { agents: [{ ...agent, feeds: [{ id: "news", volume_name: "news-volume" }] }],
      readFeedHistory: async () => { throw new Error("unresolvable feed"); } });
    expect(result).toMatchObject({ written: 1, nonExact: 1, failures: [] });
    expect((await records())[0]!.errors?.join(" ")).toMatch(/invalid/iu);
    expect((await records())[0]!.errors?.join(" ")).toContain("cannot resolve");
  });

  it("does not accept a different volume's landing history with the same resource id", async () => {
    const result = await run(execFor([wake()]), { agents: [{ ...agent, feeds: [{ id: "news", volume_name: "news-volume" }] }],
      readFeedHistory: async () => ({ entries: [{ resource: "news", volume: "foreign-volume", landed_at: startedAt }], errors: [] }) });
    expect(result).toMatchObject({ written: 1, nonExact: 1, failures: [] });
    expect((await records())[0]!.feeds).toEqual([]);
  });

  it("scopes project and home moment paths to the deployment identity", () => {
    expect(deploymentMomentsDirectory(path.join(root, "a.json"))).toBe(path.join(root, "a/moments"));
    expect(deploymentMomentsDirectory(path.join(root, "b.json"))).toBe(path.join(root, "b/moments"));
    expect(deploymentMomentsDirectory(path.join(root, "home/record.json"))).toBe(path.join(root, "home/moments"));
    expect(momentFileName(startedAt, "../../escape")).toMatch(/^20261009T082031250Z-sha256-[a-f0-9]{64}\.json$/u);
  });

  it("reports output failures and performs no recording I/O when no agent records", async () => {
    await writeFile(path.join(root, "news"), "blocked");
    expect(await run(execFor([wake()]))).toMatchObject({ written: 0, failures: [expect.any(String)] });
    const exec = vi.fn();
    expect(await run(exec, { agents: [] })).toMatchObject({ written: 0, failures: [] });
    expect(exec).not.toHaveBeenCalled();
  });
});
