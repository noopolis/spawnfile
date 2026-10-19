import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { materializeMoltnet } from "./moltnet.js";
import { momentRecordSchema } from "../../../recording/index.js";
import { openHistory } from "./history.js";
import { inspectMoltnetSqlite } from "../index.js";
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
  it("round-trips an empty actor type through the SQLite cut without rewriting stored JSON", async () => {
    const { file, database, context } = await fixture();
    room(database, "assignment"); message(database, "operator-message", before); message(database, "future", future);
    const from = '{ "type" : "", "id" : "operator" }', parts = '[ { "kind" : "text" } ]';
    database.prepare("UPDATE messages SET from_json = ?, parts_json = ? WHERE id = 'operator-message'").run(from, parts);
    const delivery = `{ "id": "operator-event", "type": "message.created", "network_id": "news", "created_at": "${before}",
      "message": { "id": "operator-message", "network_id": "news", "target": { "kind": "room", "room_id": "assignment" },
        "from": ${from}, "parts": ${parts}, "created_at": "${before}" } }`;
    database.prepare("INSERT INTO attachment_delivery_events (event_id, event_json, created_at) VALUES (?, ?, ?)")
      .run("operator-event", delivery, before);
    database.prepare("INSERT INTO attachment_delivery_cursors VALUES ('writer', 1, ?)").run(before);
    const stored = database.prepare("SELECT * FROM messages WHERE id = 'operator-message'").get();
    database.close(); const sourceBytes = await readFile(file);
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "approximate", basis: "created-at-cut" });
    const output = path.join(context.destination, "moltnet.sqlite"), result = new DatabaseSync(output, { readOnly: true });
    try {
      expect(result.prepare("SELECT * FROM messages").all()).toEqual([stored]);
      expect(result.prepare("SELECT event_json FROM attachment_delivery_events").all()).toEqual([{ event_json: delivery }]);
      expect(result.prepare("SELECT event_seq FROM attachment_delivery_cursors").all()).toEqual([{ event_seq: 1 }]);
    } finally { result.close(); }
    expect(await inspectMoltnetSqlite(output, at)).toMatchObject({ messages: 1, events: 1, findings: [] });
    expect(await readFile(file)).toEqual(sourceBytes);
  });

  it.each([{ type: "" }, { type: "", id: "" }])("refuses a SQLite actor without a nonempty id: %j", async (from) => {
    const { database, context, file } = await fixture();
    room(database, "assignment"); message(database, "operator-message", before);
    database.prepare("UPDATE messages SET from_json = ?").run(JSON.stringify(from)); database.close();
    await expect(materializeMoltnet(context)).rejects.toThrow(/"id"/);
    await expect(inspectMoltnetSqlite(file, at)).rejects.toThrow(/"id"/);
  });

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
    for (const agent of ["writer", "brass"]) database.prepare("INSERT INTO agents VALUES (?, 'news', 'uid', 'uri', NULL, 'key', ?, ?)").run(agent, before, future);
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

  it("drops future registrations and memberships, clamps retained updates and migration times, and preserves history bytes", async () => {
    const { database, context, file } = await fixture();
    room(database, "assignment"); dm(database, "dm-kept");
    message(database, "dm-old", before, { kind: "dm", dm_id: "dm-kept" });
    for (const [id, time] of [["writer", before], ["boundary", at], ["later", future]]) {
      database.prepare("INSERT INTO agents VALUES (?, 'news', ?, ?, NULL, 'key', ?, ?)").run(id, id, id, time, future);
    }
    for (const id of ["boundary", "later", "unregistered"]) {
      database.prepare("INSERT INTO room_members VALUES ('assignment', ?)").run(id);
      database.prepare("INSERT INTO dm_participants VALUES ('dm-kept', ?)").run(id);
    }
    database.prepare("INSERT INTO attachment_delivery_cursors VALUES ('later', 0, ?)").run(future);
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    for (const [version, time] of [[1, before], [2, at], [3, future]] as const) {
      database.prepare("INSERT INTO schema_migrations VALUES (?, 'migration', ?)").run(version, time);
    }
    database.close(); const sourceBytes = await readFile(file);
    await materializeMoltnet(context);
    const output = path.join(context.destination, "moltnet.sqlite"), result = new DatabaseSync(output, { readOnly: true });
    try {
      expect(result.prepare("SELECT agent_id, created_at, updated_at FROM agents ORDER BY agent_id").all()).toEqual([
        { agent_id: "boundary", created_at: at, updated_at: at }, { agent_id: "writer", created_at: before, updated_at: at }
      ]);
      expect(result.prepare("SELECT member_id FROM room_members ORDER BY member_id").all())
        .toEqual(["boundary", "unregistered", "writer"].map((member_id) => ({ member_id })));
      expect(result.prepare("SELECT participant_id FROM dm_participants ORDER BY participant_id").all())
        .toEqual(["boundary", "unregistered", "writer"].map((participant_id) => ({ participant_id })));
      expect(result.prepare("SELECT * FROM attachment_delivery_cursors").all()).toEqual([]);
      expect(result.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 1, applied_at: before }, { version: 2, applied_at: at }, { version: 3, applied_at: at }
      ]);
    } finally { result.close(); }
    expect(await readFile(file)).toEqual(sourceBytes);
    expect((await inspectMoltnetSqlite(output, at)).findings).toEqual([]);
  });

  it.each(["created_at", "updated_at"] as const)("independently flags a SQLite agent's future %s", async (field) => {
    const { database, file } = await fixture();
    database.prepare("INSERT INTO agents VALUES ('writer', 'news', 'uid', 'uri', NULL, 'key', ?, ?)")
      .run(field === "created_at" ? future : before, field === "updated_at" ? future : before);
    database.close(); const bytes = await readFile(file);
    expect((await inspectMoltnetSqlite(file, at)).findings).toEqual([
      { class: "moltnet-event", path: file, detail: `Agent writer has a future ${field}` }
    ]);
    expect(await readFile(file)).toEqual(bytes);
  });

  it("independently flags future schema migration times", async () => {
    const { database, file } = await fixture();
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    database.prepare("INSERT INTO schema_migrations VALUES (1, 'migration', ?)").run(future);
    database.close(); const bytes = await readFile(file);
    expect((await inspectMoltnetSqlite(file, at)).findings).toEqual([
      { class: "moltnet-event", path: file, detail: "Schema migration 1 has a future applied_at" }
    ]);
    expect(await readFile(file)).toEqual(bytes);
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
    expect(await inspectMoltnetSqlite(output, at)).toMatchObject({
      registrations: [], rooms: [], nonCanonicalCredentialAgentIds: [],
      findings: [{ class: "moltnet-event", detail: expect.stringContaining("sidecar") }]
    });
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


it("returns room/sender-filtered messages in native history order while auditing excluded rows", async () => {
  const { database, file } = await fixture();
  room(database, "assignment"); room(database, "elsewhere");
  message(database, "z", before); message(database, "a", before); message(database, "later", at);
  message(database, "other-room", before, { kind: "room", room_id: "elsewhere" });
  message(database, "other-sender", before);
  database.prepare("UPDATE messages SET from_json = ? WHERE id = 'other-sender'")
    .run(JSON.stringify({ type: "agent", id: "another" }));
  message(database, "future-excluded", future, { kind: "room", room_id: "elsewhere" });
  database.close(); const bytes = await readFile(file);
  const result = await inspectMoltnetSqlite(file, at, { room: "assignment", sender: "writer" });
  expect(result.orderedMessages.map(row => row.id)).toEqual(["later", "a", "z"]);
  expect(result.orderedMessages.map(row => row.appendIndex)).toEqual([3, 2, 1]);
  expect(result.messages).toBe(6);
  expect(result.findings).toEqual([{ class: "moltnet-message", path: file, detail: "Message future-excluded is later than the moment" }]);
  expect((await inspectMoltnetSqlite(file, at, { sender: "another" })).orderedMessages.map(row => row.id)).toEqual(["other-sender"]);
  expect(await readFile(file)).toEqual(bytes);
});
it("exposes native append positions for reversed inserts without changing timestamp order or filtering positions", async () => {
  const stores = [];
  for (const ids of [["z", "excluded", "a", "later"], ["later", "a", "excluded", "z"]]) {
    const { database, file } = await fixture();
    room(database, "assignment"); room(database, "elsewhere");
    for (const id of ids) message(database, id, id === "later" ? at : before,
      { kind: "room", room_id: id === "excluded" ? "elsewhere" : "assignment" });
    // A deleted row leaves a gap: appendIndex must be the native rowid, not a dense rank.
    database.prepare("DELETE FROM messages WHERE id = 'excluded'").run();
    database.close(); const bytes = await readFile(file);
    const all = await inspectMoltnetSqlite(file, at);
    const filtered = await inspectMoltnetSqlite(file, at, { room: "assignment", sender: "writer" });
    expect(filtered.orderedMessages).toEqual(all.orderedMessages);
    expect(all.findings).toEqual([]);
    expect(await readFile(file)).toEqual(bytes);
    stores.push(all.orderedMessages);
  }
  const withoutPositions = stores.map(rows => rows.map(({ appendIndex, ...rest }) => rest));
  expect(withoutPositions[0]).toEqual(withoutPositions[1]);
  expect(stores.map(rows => rows.map(({ id, appendIndex }) => [id, appendIndex]))).toEqual([
    [["later", 4], ["a", 3], ["z", 1]],
    [["later", 1], ["a", 2], ["z", 4]]
  ]);
});

it("audits cursor timestamps at nanosecond precision", async () => {
  const { database, file } = await fixture();
  database.prepare("INSERT INTO attachment_delivery_cursors VALUES ('caller', 0, ?)").run("2026-10-09T10:00:00.100000001Z");
  database.close();
  expect((await inspectMoltnetSqlite(file, at)).findings).toEqual([
    { class: "moltnet-event", path: file, detail: "Attachment cursor caller has a future updated_at" }
  ]);
});
it.each(["CREATE TABLE surprise (value TEXT)", "CREATE VIEW surprise AS SELECT id FROM messages",
  "CREATE TRIGGER surprise AFTER INSERT ON messages BEGIN DELETE FROM rooms; END"])("inspector refuses undeclared objects: %s", async sql => {
  const { database, file } = await fixture(); database.exec(sql); database.close();
  await expect(inspectMoltnetSqlite(file, at)).rejects.toThrow(/Unsupported Moltnet SQLite/);
});
it("refuses malformed stored timestamps and an invalid cutoff even in an empty store", async () => {
  const { database, file } = await fixture();
  database.prepare("INSERT INTO attachment_delivery_cursors VALUES ('caller', 0, 'invalid')").run(); database.close();
  await expect(inspectMoltnetSqlite(file, at)).rejects.toThrow();
  await expect(inspectMoltnetSqlite(file, "invalid")).rejects.toThrow();
});

it("exposes only audit IDs for all registrations, active rooms, memberships and noncanonical credentials", async () => {
  const { database, file } = await fixture();
  room(database, "z-room"); room(database, "a-room"); room(database, "deleted", before, before);
  database.prepare("INSERT INTO room_members VALUES ('a-room', 'alpha')").run();
  const register = database.prepare("INSERT INTO agents VALUES (?, ?, ?, 'actor-uri', 'display', ?, ?, ?)");
  register.run("z-agent", "network-b", "actor-z", "token:z-agent", before, before);
  register.run("a-agent", "network-a", "actor-a", "synthetic-noncanonical-value", before, before);
  register.run("empty", "network-a", "", "", before, before);
  message(database, "excluded", before);
  database.close(); const bytes = await readFile(file);
  const result = await inspectMoltnetSqlite(file, at, { room: "absent", sender: "absent" });
  expect(result.orderedMessages).toEqual([]);
  expect(result.registrations).toEqual([
    { agentId: "a-agent", networkId: "network-a", actorUid: "actor-a" },
    { agentId: "empty", networkId: "network-a", actorUid: "" },
    { agentId: "z-agent", networkId: "network-b", actorUid: "actor-z" }
  ]);
  expect(result.rooms).toEqual([
    { id: "a-room", networkId: "news", memberIds: ["alpha", "writer"] },
    { id: "z-room", networkId: "news", memberIds: ["writer"] }
  ]);
  expect(result.nonCanonicalCredentialAgentIds).toEqual(["a-agent", "empty"]);
  expect(result.findings).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/credential_key|token:z-agent|synthetic-noncanonical-value|actor-uri|display/);
  expect(await readFile(file)).toEqual(bytes);
});
