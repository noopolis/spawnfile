import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeployResources } from "../deployment/index.js";
import { agent, chunkExec, execFor, now, startedAt, wake } from "./fixtures.test-helper.js";
import type { UsageLedgerExec } from "../runtime/usageLedgerRead.js";
import { deploymentMomentsDirectory, momentFileName } from "./store.js";
import { syncMomentRecords } from "./sync.js";
import type { MomentRecord } from "./types.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "record-sync-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const recordPath = () => path.join(root, "news.json");
const directory = () => path.join(deploymentMomentsDirectory(recordPath()), "writer");
const records = async (): Promise<MomentRecord[]> => Promise.all((await readdir(directory())).filter((name) => name.endsWith(".json"))
  .map(async (name) => JSON.parse(await readFile(path.join(directory(), name), "utf8")) as MomentRecord));
const run = (exec: UsageLedgerExec, extra: Partial<Parameters<typeof syncMomentRecords>[0]> = {}) => {
  const agents = extra.agents ?? [agent];
  return syncMomentRecords({
    recordPath: recordPath(), agents, execForAgent: () => exec,
    readFeedHistory: async () => ({ entries: [], errors: [] }), now,
    readDeployHistory: () => ({ entries: [createDeployResources(recordPath(), {
      name: "news", created_at: "2026-10-01T00:00:00Z", activated_at: "2026-10-01T00:00:00Z", activation_exact: true
    }, { recording: { keep_ms: agent.keep_ms, memory_mount_ids: [], agents: [...agents] } }, "report")], errors: [] }), ...extra
  });
};

describe("syncMomentRecords", () => {
  it("reads in bounded chunks, publishes private records, and never rewrites them on a second sync", async () => {
    const exec = execFor([wake()]);
    expect(await run(exec)).toMatchObject({ written: 1, skipped: 0, nonExact: 0, failures: [] });
    const file = path.join(directory(), momentFileName(wake()));
    const before = await readFile(file, "utf8"), metadata = await stat(file);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(exec).toHaveBeenCalledWith(["node", "-e", expect.any(String), "/data/self/memory/events.jsonl", "0", "262144"]);
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

  it.each(["errors", "snapshots"])("distinguishes equal-time attempts with different %s and skips only the same row", async (difference) => {
    const first = wake(), second = wake();
    if (difference === "errors") second.error = "state: partial snapshot";
    else second.snapshots[0]!.snapshot += ".2";
    const exec = execFor([first, second]);
    expect(await run(exec)).toMatchObject({ written: 2, skipped: 0, failures: [] });
    expect(await records()).toHaveLength(2);
    expect(await readdir(directory())).toEqual(expect.arrayContaining([momentFileName(first), momentFileName(second)]));
    expect(momentFileName(first)).toMatch(/-[a-f0-9]{12}\.json$/u);
    expect(await run(exec)).toMatchObject({ written: 0, skipped: 2, failures: [] });
    expect(await records()).toHaveLength(2);
  });

  it("canonicalizes row object keys but retains values and array order in the attempt identity", () => {
    const row = wake();
    const reordered = { ...Object.fromEntries(Object.entries(row).reverse()),
      snapshots: row.snapshots.map((snapshot) => Object.fromEntries(Object.entries(snapshot).reverse())) };
    expect(momentFileName(reordered as typeof row)).toBe(momentFileName(row));
    expect(momentFileName({ ...row, snapshots: [{ ...row.snapshots[0]!, skipped: 1 }] })).not.toBe(momentFileName(row));
  });

  it("reads historical ledger paths and removed feeds/resources after a release, from the real persisted log", async () => {
    const oldTime = "2026-10-09T08:00:00.000Z", releaseTime = "2026-10-09T08:30:00.000Z";
    const oldFacts = { ...agent, resources: [{ id: "archive", kind: "git" as const }],
      feeds: [{ id: "news", volume_name: "old-news-volume" }] };
    const current = { ...agent, networks: ["new-desk"], memory: [{ id: "self", declared_by: "team:new", ledger_path: "/new/events.jsonl" }],
      feeds: [{ id: "news", volume_name: "new-news-volume" }] };
    const report = (facts: typeof agent) => ({ recording: { agents: [facts], keep_ms: agent.keep_ms, memory_mount_ids: [] },
      workspace_git_resources: facts.resources.map(({ id }) => ({ id, agent_node_ids: [agent.node_id], commit: "a".repeat(40), sha256: `sha256:${"b".repeat(64)}` })) });
    const entries = [createDeployResources(recordPath(), { name: "news", created_at: oldTime, activated_at: oldTime, activation_exact: true }, report(oldFacts), "old"),
      createDeployResources(recordPath(), { name: "news", created_at: releaseTime, activated_at: releaseTime, activation_exact: true }, report(current), "new")];
    await writeFile(path.join(root, "news.resource-log.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const exec = chunkExec((file) => file.endsWith("wake-moments.jsonl")
      ? [wake(), wake(releaseTime)].map((row) => JSON.stringify(row)).join("\n")
      : JSON.stringify({ seq: file === "/new/events.jsonl" ? 99 : 7, createdAt: oldTime }));
    const readFeedHistory = vi.fn(async (feed: typeof oldFacts.feeds[number]) => ({ entries: [{
      version: "spawnfile.volume-feed-landing.v1" as const, resource: "news", volume: feed.volume_name,
      switching_at: oldTime, landed_at: oldTime, revision: "a".repeat(64), tree: `trees/${feed.volume_name}`,
      source: { kind: "directory" as const, directory: "/feed" }
    }], errors: [] }));
    expect(await run(exec, { agents: [current], readDeployHistory: undefined, readFeedHistory })).toMatchObject({ written: 2, nonExact: 0, failures: [] });
    const moments = await records();
    expect(moments.find((row) => row.wake.startedAt === startedAt)).toMatchObject({ exact: true,
      resources: [{ id: "archive", commit: "a".repeat(40) }], memory: [{ declaredBy: "agent:writer", seq: 7 }],
      feeds: [{ tree: "trees/old-news-volume" }], moltnet: [{ network: "news" }] });
    expect(moments.find((row) => row.wake.startedAt === releaseTime)).toMatchObject({ exact: true,
      resources: [], memory: [{ declaredBy: "team:new", seq: 99 }], feeds: [{ tree: "trees/new-news-volume" }], moltnet: [{ network: "new-desk" }] });
    expect(readFeedHistory).toHaveBeenCalledWith(oldFacts.feeds[0]);
    expect(readFeedHistory).toHaveBeenCalledWith(current.feeds[0]);
  });

  it("reads wake logs and ledgers larger than the gateway buffer without losing rows or boundary sequences", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => wake(startedAt, `attempt-${index}`));
    const ledger = Array.from({ length: 50 }, (_, index) => JSON.stringify({ seq: index + 1,
      createdAt: index === 49 ? now().toISOString() : startedAt, content: "Unicode 🦉 文".repeat(15) })).join("\n");
    const wakeLog = rows.map((row) => JSON.stringify(row)).join("\n");
    const maxBuffer = 512;
    expect(Buffer.byteLength(ledger)).toBeGreaterThan(maxBuffer);
    expect(Buffer.byteLength(wakeLog)).toBeGreaterThan(maxBuffer);
    const exec = chunkExec((file) => file.endsWith("wake-moments.jsonl") ? wakeLog : ledger, maxBuffer);
    expect(await run(exec, { readChunkBytes: 192 })).toMatchObject({ written: 4, nonExact: 0, failures: [] });
    expect((await records()).map((record) => record.memory[0]!.seq)).toEqual([49, 49, 49, 49]);
  });

  it("marks rows before the first activation non-exact even when the current agent has no pins", async () => {
    expect(await run(execFor([wake()]), { readDeployHistory: () => ({ entries: [], errors: [] }) }))
      .toMatchObject({ written: 1, nonExact: 1, failures: [] });
    expect((await records())[0]).toMatchObject({ resources: [], memory: [], errors: [expect.stringContaining("Missing deployment history")] });
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
    const unreadable = chunkExec((file) => {
      if (file.endsWith("wake-moments.jsonl")) return JSON.stringify(wake());
      throw new Error("permission denied");
    });
    expect(await run(unreadable)).toMatchObject({ written: 1, nonExact: 1, failures: [] });
    expect((await records())[0]).toMatchObject({ exact: false, errors: [expect.stringContaining("unreadable")] });
    const absent = chunkExec((file) => file.endsWith("wake-moments.jsonl")
      ? JSON.stringify(wake("2026-10-09T08:22:00Z", "new")) : null);
    expect(await run(absent)).toMatchObject({ written: 1, nonExact: 0, failures: [] });
    expect((await records()).find((record) => record.wake.executionId === "new")?.memory).toEqual([{ id: "self", declaredBy: agent.node_id, seq: 0 }]);
  });

  it("reports failed wake reads as operational failures and absent wake files as empty", async () => {
    expect(await run(async () => { throw Object.assign(new Error("docker: no such file or directory"), { code: "ENOENT" }); }))
      .toMatchObject({ written: 0, failures: [expect.stringContaining("unreadable")] });
    expect(await run(chunkExec(() => null)))
      .toMatchObject({ written: 0, failures: [] });
  });

  it("propagates corrupt lines and unresolved feed histories without aborting records", async () => {
    const exec = chunkExec((file) => file.endsWith("wake-moments.jsonl") ? `${JSON.stringify(wake())}\nbad line\n` : "");
    const result = await run(exec, { agents: [{ ...agent, feeds: [{ id: "news", volume_name: "news-volume" }] }],
      readFeedHistory: async () => { throw new Error("unresolvable feed"); } });
    expect(result).toMatchObject({ written: 1, nonExact: 1, failures: [] });
    expect((await records())[0]!.errors?.join(" ")).toMatch(/invalid/iu);
    expect((await records())[0]!.errors?.join(" ")).toContain("cannot resolve");
  });

  it("does not accept a different volume's landing history with the same resource id", async () => {
    const result = await run(execFor([wake()]), { agents: [{ ...agent, feeds: [{ id: "news", volume_name: "news-volume" }] }],
      readFeedHistory: async () => ({ entries: [{ version: "spawnfile.volume-feed-landing.v1", resource: "news", volume: "foreign-volume",
        revision: "a".repeat(64), tree: `trees/${"a".repeat(64)}`, source: { kind: "directory", directory: "/feed" },
        switching_at: startedAt, landed_at: startedAt }], errors: [] }) });
    expect(result).toMatchObject({ written: 1, nonExact: 1, failures: [] });
    expect((await records())[0]!.feeds).toEqual([]);
  });

  it("scopes project and home moment paths to the deployment identity", () => {
    expect(deploymentMomentsDirectory(path.join(root, "a.json"))).toBe(path.join(root, "a/moments"));
    expect(deploymentMomentsDirectory(path.join(root, "b.json"))).toBe(path.join(root, "b/moments"));
    expect(deploymentMomentsDirectory(path.join(root, "home/record.json"))).toBe(path.join(root, "home/moments"));
    expect(momentFileName(wake(startedAt, "../../escape"))).toMatch(/^20261009T082031250Z-sha256-[a-f0-9]{64}-[a-f0-9]{12}\.json$/u);
  });

  it("reports output failures and performs no recording I/O when no agent records", async () => {
    await writeFile(path.join(root, "news"), "blocked");
    expect(await run(execFor([wake()]))).toMatchObject({ written: 0, failures: [expect.any(String)] });
    const exec = vi.fn();
    expect(await run(exec, { agents: [] })).toMatchObject({ written: 0, failures: [] });
    expect(exec).not.toHaveBeenCalled();
  });
});
