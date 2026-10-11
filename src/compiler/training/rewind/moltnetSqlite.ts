import { lstat, rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { compareInstants } from "./instant.js";
import { inspectMoltnetEvent, latestMoltnetMessage, moltnetMessages, rewindMoltnetJson } from "./moltnetJson.js";
import { readMoltnetSqlite, sqliteInteger, sqliteText, sqliteJson } from "./moltnetSqliteData.js";
import { moltnetEventSchema, type MoltnetFinding, type MoltnetInspection, type MoltnetMessage } from "./moltnetSchemas.js";

const openSqlite = async (file: string, readOnly = false): Promise<DatabaseSync> => {
  let sqlite: typeof import("node:sqlite");
  try { sqlite = await import("node:sqlite"); }
  catch { throw new Error("Moltnet SQLite rewind requires node:sqlite (supported Node >=22.19); this Node runtime does not expose it"); }
  return new sqlite.DatabaseSync(file, { readOnly, enableForeignKeyConstraints: false, allowExtension: false });
};

/** Mutates only a caller-created COPY. secure_delete and VACUUM remove future content from free pages. */
export const rewindMoltnetSqlite = async (file: string, at: string): Promise<MoltnetMessage[]> => {
  const database = await openSqlite(file);
  try {
    const source = readMoltnetSqlite(database), cut = rewindMoltnetJson(source, at);
    const messages = moltnetMessages(cut), keepMessages = new Set(messages.map((message) => message.id));
    const eventRows = database.prepare("SELECT * FROM attachment_delivery_events ORDER BY seq").all();
    const keepEvents = new Set(cut.attachment_delivery_events.map((event) => event.id));
    // The database column and the embedded event each carry an instant; both must pass the cut.
    const remainingEvents = eventRows.filter((row) => keepEvents.has(sqliteText(row, "event_id"))
      && compareInstants(sqliteText(row, "created_at"), at) <= 0);
    const remainingSeq = new Set(remainingEvents.map((row) => sqliteInteger(row, "seq")));
    database.exec("PRAGMA secure_delete=ON; PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      const dropMessage = database.prepare("DELETE FROM messages WHERE id = ?");
      for (const message of moltnetMessages(source)) if (!keepMessages.has(message.id)) dropMessage.run(message.id);
      const dropRoom = database.prepare("DELETE FROM rooms WHERE id = ?"), restoreRoom = database.prepare("UPDATE rooms SET deleted_at = NULL WHERE id = ?");
      for (const id of Object.keys(source.rooms)) {
        if (!cut.rooms[id]) dropRoom.run(id);
        else if (source.removed_rooms[id] && !cut.removed_rooms[id]) restoreRoom.run(id);
      }
      database.exec("DELETE FROM room_members WHERE room_id NOT IN (SELECT id FROM rooms)");
      const dropThread = database.prepare("DELETE FROM threads WHERE id = ?");
      const updateThread = database.prepare("UPDATE threads SET message_count = ?, last_message_at = ? WHERE id = ?");
      for (const id of Object.keys(source.threads)) {
        const thread = cut.threads[id];
        if (!thread) dropThread.run(id); else updateThread.run(thread.message_count, thread.last_message_at!, id);
      }
      const dropDm = database.prepare("DELETE FROM dm_conversations WHERE dm_id = ?");
      const updateDm = database.prepare("UPDATE dm_conversations SET message_count = ?, last_message_at = ? WHERE dm_id = ?");
      for (const row of database.prepare("SELECT dm_id FROM dm_conversations").all()) {
        const id = sqliteText(row, "dm_id"), retained = cut.direct_messages[id] ?? [];
        if (!retained.length) dropDm.run(id); else updateDm.run(retained.length, latestMoltnetMessage(retained)!.created_at, id);
      }
      database.exec("DELETE FROM dm_participants WHERE dm_id NOT IN (SELECT dm_id FROM dm_conversations)");
      database.exec("DELETE FROM artifacts WHERE message_id NOT IN (SELECT id FROM messages)");
      const dropArtifact = database.prepare("DELETE FROM artifacts WHERE id = ?");
      for (const row of database.prepare("SELECT id, created_at FROM artifacts").all()) {
        if (compareInstants(sqliteText(row, "created_at"), at) > 0) dropArtifact.run(sqliteText(row, "id"));
      }
      const dropEvent = database.prepare("DELETE FROM attachment_delivery_events WHERE seq = ?");
      for (const row of eventRows) if (!remainingSeq.has(sqliteInteger(row, "seq"))) dropEvent.run(sqliteInteger(row, "seq"));
      const updateCursor = database.prepare("UPDATE attachment_delivery_cursors SET event_seq = ?, updated_at = ? WHERE agent_id = ?");
      for (const row of database.prepare("SELECT * FROM attachment_delivery_cursors").all()) {
        const cursor = sqliteInteger(row, "event_seq");
        const clamped = remainingEvents.reduce((value, event) => {
          const seq = sqliteInteger(event, "seq"); return seq <= cursor ? Math.max(value, seq) : value;
        }, 0);
        const updated = sqliteText(row, "updated_at");
        updateCursor.run(clamped, compareInstants(updated, at) > 0 ? at : updated, sqliteText(row, "agent_id"));
      }
      const hasSequence = database.prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_sequence'").get();
      if (hasSequence) database.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'attachment_delivery_events'")
        .run(remainingEvents.reduce((value, row) => Math.max(value, sqliteInteger(row, "seq")), 0));
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM");
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Rewound Moltnet SQLite integrity check failed");
    return messages;
  } finally {
    database.close();
    for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${file}${suffix}`, { force: true });
  }
};

/** Reopens on-disk SQLite read-only; no materializer state or cut helper supplies the verdict. */
export const inspectMoltnetSqlite = async (file: string, at: string): Promise<MoltnetInspection> => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const entry = await lstat(`${file}${suffix}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    // The materialized database is checkpointed. Refuse sidecars before SQLite can recover or touch them.
    if (entry) return { messages: 0, events: 0, findings: [{ class: "moltnet-event", path: `${file}${suffix}`,
      detail: "Materialized Moltnet SQLite has an uninspected journal/WAL sidecar" }] };
  }
  const database = await openSqlite(file, true);
  try {
    const snapshot = readMoltnetSqlite(database), messages = moltnetMessages(snapshot);
    const findings: MoltnetFinding[] = [];
    const check = (instant: string, kind: MoltnetFinding["class"], detail: string) => {
      if (compareInstants(instant, at) > 0) findings.push({ class: kind, path: file, detail });
    };
    for (const message of messages) check(message.created_at, "moltnet-message", `Message ${message.id} is later than the moment`);
    for (const room of Object.values(snapshot.rooms)) check(room.created_at, "moltnet-room", `Room ${room.id} is later than the moment`);
    for (const [id, instant] of Object.entries(snapshot.removed_rooms)) check(instant, "moltnet-room", `Room ${id} has a future removal marker`);
    for (const row of database.prepare("SELECT id, created_at FROM artifacts").all()) {
      check(sqliteText(row, "created_at"), "moltnet-message", `Artifact ${row.id} is later than the moment`);
    }
    for (const [table, id] of [["threads", "id"], ["dm_conversations", "dm_id"]]) {
      for (const row of database.prepare(`SELECT ${id}, last_message_at FROM ${table}`).all()) {
        check(sqliteText(row, "last_message_at"), "moltnet-message", `${table} ${row[id]} has a future counter`);
      }
    }
    const events = database.prepare("SELECT * FROM attachment_delivery_events").all();
    for (const row of events) {
      check(sqliteText(row, "created_at"), "moltnet-event", `Attachment event ${row.event_id} is later than the moment`);
      findings.push(...inspectMoltnetEvent(moltnetEventSchema.parse(sqliteJson(row, "event_json")), at, file));
    }
    return { messages: messages.length, events: events.length, findings };
  } finally { database.close(); }
};
