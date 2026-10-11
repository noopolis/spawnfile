import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { materializeMoltnet } from "./moltnet.js";
import { momentRecordSchema } from "./contract.js";
import { openHistory } from "./history.js";
import { inspectMoltnetSqlite } from "./moltnetSqlite.js";
import type { InputContext } from "./types.js";

const at = "2026-10-09T10:00:00.1Z", before = "2026-10-09T10:00:00Z", future = "2026-10-09T10:00:00.11Z";
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const schema = `
CREATE TABLE rooms (id TEXT PRIMARY KEY, network_id TEXT, fqid TEXT, name TEXT, created_at TEXT, deleted_at TEXT,
  visibility TEXT DEFAULT 'private', write_policy TEXT DEFAULT 'members', federation TEXT DEFAULT '"none"');
CREATE TABLE room_members (room_id TEXT, member_id TEXT);
CREATE TABLE threads (id TEXT PRIMARY KEY, network_id TEXT, fqid TEXT, room_id TEXT, parent_message_id TEXT,
  message_count INTEGER, last_message_at TEXT);
CREATE TABLE dm_conversations (dm_id TEXT PRIMARY KEY, network_id TEXT, fqid TEXT, message_count INTEGER, last_message_at TEXT);
CREATE TABLE dm_participants (dm_id TEXT, participant_id TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, network_id TEXT, target_kind TEXT, room_id TEXT, thread_id TEXT,
  parent_message_id TEXT, dm_id TEXT, target_json TEXT, from_json TEXT, parts_json TEXT, mentions_json TEXT,
  created_at TEXT, origin_json TEXT DEFAULT '{}');
CREATE TABLE artifacts (id TEXT PRIMARY KEY, message_id TEXT, created_at TEXT);
CREATE TABLE agents (agent_id TEXT PRIMARY KEY, network_id TEXT, actor_uid TEXT, actor_uri TEXT,
  display_name TEXT, credential_key TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE attachment_delivery_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, event_json TEXT, created_at TEXT);
CREATE TABLE attachment_delivery_cursors (agent_id TEXT PRIMARY KEY, event_seq INTEGER, updated_at TEXT);`;
const room = (database: DatabaseSync, id: string, time = before, deleted: string | null = null) => {
  database.prepare("INSERT INTO rooms (id, network_id, fqid, name, created_at, deleted_at) VALUES (?, 'news', ?, ?, ?, ?)")
    .run(id, `molt://news/rooms/${id}`, id, time, deleted);
  database.prepare("INSERT INTO room_members VALUES (?, 'writer')").run(id);
};
const message = (database: DatabaseSync, id: string, time: string, target: Record<string, string> = { kind: "room", room_id: "assignment" }) => {
  database.prepare(`INSERT INTO messages (id, network_id, target_kind, room_id, thread_id, parent_message_id, dm_id,
    target_json, from_json, parts_json, mentions_json, created_at) VALUES (?, 'news', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`)
    .run(id, target.kind, target.room_id ?? null, target.thread_id ?? null, target.parent_message_id ?? null,
      target.dm_id ?? null, JSON.stringify(target), JSON.stringify({ type: "agent", id: "writer" }),
      JSON.stringify([{ kind: "text", text: id.startsWith("future") ? "SECRET_FUTURE_PAYLOAD" : id }]), time);
};
const thread = (database: DatabaseSync, id: string, root: string) => database.prepare("INSERT INTO threads VALUES (?, 'news', ?, 'assignment', ?, 99, ?)")
  .run(id, `molt://news/threads/${id}`, root, future);
const dm = (database: DatabaseSync, id: string) => {
  database.prepare("INSERT INTO dm_conversations VALUES (?, 'news', ?, 99, ?)").run(id, `molt://news/dms/${id}`, future);
  database.prepare("INSERT INTO dm_participants VALUES (?, 'writer')").run(id);
};
const event = (database: DatabaseSync, id: string, time: string) => database.prepare("INSERT INTO attachment_delivery_events (event_id, event_json, created_at) VALUES (?, ?, ?)")
  .run(id, JSON.stringify({ id, type: "agent.connected", network_id: "news", created_at: time }), time);
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rewind-moltnet-sqlite-")); temps.push(root);
  const bank = path.join(root, "moltnet/team%3Aorg/news"); await mkdir(bank, { recursive: true });
  const file = path.join(bank, "moltnet.sqlite"), database = new DatabaseSync(file); database.exec(schema);
  const context: InputContext = { at, record: null, history: await openHistory(root), destination: path.join(root, "out"),
    input: { section: "networks", id: "news", declaredBy: "team:org", overridden: false, declarationBase: root,
      declaration: { id: "news", provider: "moltnet", rooms: [{ id: "assignment", members: ["writer"] }] } } };
  return { root, bank, file, database, context };
};

describe("Moltnet SQLite rewind", () => {
  it("cuts a copy, preserves nanos ordering, prunes topology/artifacts, restores rooms, and erases deleted payload bytes", async () => {
    const { file, database, context } = await fixture();
    room(database, "assignment"); room(database, "future-room", future); room(database, "restored", before, future); room(database, "removed", before, before);
    message(database, "old", before); message(database, "boundary", at); message(database, "future-root", future);
    message(database, "regressed-room", before, { kind: "room", room_id: "future-room" });
    thread(database, "kept", "old"); thread(database, "dropped", "future-root");
    message(database, "thread-old", before, { kind: "thread", room_id: "assignment", thread_id: "kept" });
    message(database, "future-thread", future, { kind: "thread", room_id: "assignment", thread_id: "kept" });
    message(database, "thread-regressed", before, { kind: "thread", room_id: "assignment", thread_id: "dropped" });
    dm(database, "dm-kept"); dm(database, "dm-dropped");
    message(database, "dm-old", before, { kind: "dm", dm_id: "dm-kept" });
    message(database, "future-dm", future, { kind: "dm", dm_id: "dm-kept" });
    message(database, "future-dm-root", future, { kind: "dm", dm_id: "dm-dropped" });
    message(database, "dm-regressed", before, { kind: "dm", dm_id: "dm-dropped" });
    database.prepare("INSERT INTO artifacts VALUES (?, ?, ?)").run("old-artifact", "old", before);
    database.prepare("INSERT INTO artifacts VALUES (?, ?, ?)").run("future-artifact", "future-root", future);
    for (const agent of ["writer", "brass"]) database.prepare("INSERT INTO agents VALUES (?, 'news', 'uid', 'uri', NULL, 'key', ?, ?)").run(agent, future, future);
    event(database, "event-old", before); event(database, "event-future", future); event(database, "event-boundary", at);
    database.prepare("INSERT INTO attachment_delivery_cursors VALUES (?, ?, ?)").run("writer", 2, future);
    database.prepare("INSERT INTO attachment_delivery_cursors VALUES (?, ?, ?)").run("brass", 3, future);
    database.close();
    const sourceBytes = await readFile(file);
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "approximate", basis: "created-at-cut" });
    expect(await readFile(file)).toEqual(sourceBytes);
    const output = path.join(context.destination, "moltnet.sqlite"), result = new DatabaseSync(output, { readOnly: true });
    try {
      expect(result.prepare("SELECT id FROM messages ORDER BY id").all().map((row) => row.id)).toEqual(["boundary", "dm-old", "old", "thread-old"]);
      expect(result.prepare("SELECT id, message_count, last_message_at FROM threads").all()).toEqual([{ id: "kept", message_count: 1, last_message_at: before }]);
      expect(result.prepare("SELECT dm_id, message_count, last_message_at FROM dm_conversations").all()).toEqual([{ dm_id: "dm-kept", message_count: 1, last_message_at: before }]);
      expect(result.prepare("SELECT id, deleted_at FROM rooms WHERE id IN ('restored', 'removed') ORDER BY id").all())
        .toEqual([{ id: "removed", deleted_at: before }, { id: "restored", deleted_at: null }]);
      expect(result.prepare("SELECT id FROM rooms WHERE id = 'future-room'").get()).toBeUndefined();
      expect(result.prepare("SELECT * FROM artifacts").all()).toEqual([{ id: "old-artifact", message_id: "old", created_at: before }]);
      expect(result.prepare("SELECT agent_id, event_seq, updated_at FROM attachment_delivery_cursors ORDER BY agent_id").all())
        .toEqual([{ agent_id: "brass", event_seq: 3, updated_at: at }, { agent_id: "writer", event_seq: 1, updated_at: at }]);
      expect(result.prepare("SELECT count(*) AS total FROM agents").get()?.total).toBe(2);
    } finally { result.close(); }
    expect((await readFile(output)).includes(Buffer.from("SECRET_FUTURE_PAYLOAD"))).toBe(false);
    expect(await readdir(context.destination)).toEqual(["moltnet.sqlite"]);
    expect(await inspectMoltnetSqlite(output, at)).toMatchObject({ messages: 4, events: 2, findings: [] });
    context.record = momentRecordSchema.parse({ version: "spawnfile.moment-record.v1", agent: "agent:writer",
      wake: { at, startedAt: at, executionId: "turn-1", deliveries: [{ deliveryId: "moltnet:old", kind: "message", occurredAt: at }],
        surface: "moltnet", room: "assignment", from: "brass" }, recordedAt: at, exact: true,
      resources: [], feeds: [], memory: [], moltnet: [{ network: "news", cursor: at, messageIds: ["old", "boundary"] }], volumes: [] });
    context.destination += "-exact";
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "exact", basis: "record-cursor" });
    context.record.moltnet[0]!.messageIds = ["old", "future-root"];
    await expect(materializeMoltnet(context)).rejects.toThrow(/wake message.*future-root.*not retained/);
    context.record.moltnet[0]!.messageIds = ["missing"];
    await expect(materializeMoltnet(context)).rejects.toThrow(/wake message.*missing.*not retained/);
    delete context.record.moltnet[0]!.messageIds;
    context.record.moltnet[0]!.cursor = "2026-10-09T12:00:00.100000000+02:00";
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "exact", basis: "record-cursor" });
    for (const cursor of [before, future]) {
      context.record.moltnet[0]!.cursor = cursor;
      await expect(materializeMoltnet(context)).rejects.toThrow(/cursor must equal.*startedAt/);
    }
  });

  it("copies WAL state and independently detects message, room and attachment-event mutations without changing the file", async () => {
    const { database, context } = await fixture();
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    room(database, "assignment"); message(database, "cursor", at);
    try { expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "approximate" }); }
    finally { database.close(); }
    const output = path.join(context.destination, "moltnet.sqlite");
    expect(await inspectMoltnetSqlite(output, at)).toMatchObject({ messages: 1, findings: [] });
    const mutate = new DatabaseSync(output);
    room(mutate, "future", future); message(mutate, "future-message", future); event(mutate, "future-event", future); mutate.close();
    const bytes = await readFile(output), findings = (await inspectMoltnetSqlite(output, at)).findings;
    expect(new Set(findings.map((finding) => finding.class))).toEqual(new Set(["moltnet-message", "moltnet-room", "moltnet-event"]));
    expect(await readFile(output)).toEqual(bytes); expect(await readdir(context.destination)).toEqual(["moltnet.sqlite"]);
    await writeFile(`${output}-wal`, "uninspected bytes");
    expect((await inspectMoltnetSqlite(output, at)).findings).toMatchObject([{ class: "moltnet-event", detail: expect.stringContaining("sidecar") }]);
    expect(await readFile(`${output}-wal`, "utf8")).toBe("uninspected bytes");
  });

  it("refuses unknown persistent state rather than silently retaining it", async () => {
    const { database, context } = await fixture();
    database.exec("CREATE TABLE unknown_future_state (payload TEXT)"); database.close();
    await expect(materializeMoltnet(context)).rejects.toThrow("Unsupported Moltnet SQLite table unknown_future_state");
  });

  it("refuses unrecognized table columns rather than silently retaining added state", async () => {
    const { database, context } = await fixture();
    database.exec("ALTER TABLE messages ADD COLUMN later_edits TEXT"); database.close();
    await expect(materializeMoltnet(context)).rejects.toThrow("Unsupported Moltnet SQLite column messages.later_edits");
  });
});
