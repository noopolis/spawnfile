import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { parseMoltnetSnapshot } from "./moltnetJson.js";
import { moltnetEventSchema, type MoltnetSnapshot } from "./moltnetSchemas.js";

export type SqliteRow = Record<string, SQLOutputValue>;
export const sqliteText = (row: SqliteRow, key: string): string => {
  if (typeof row[key] !== "string") throw new Error(`Invalid Moltnet SQLite ${key}: expected text`);
  return row[key];
};
export const sqliteInteger = (row: SqliteRow, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Moltnet SQLite ${key}: expected nonnegative safe integer`);
  }
  return value;
};
export const sqliteJson = (row: SqliteRow, key: string): unknown => {
  try { return JSON.parse(sqliteText(row, key)); }
  catch (error) { throw new Error(`Invalid Moltnet SQLite ${key}: ${(error as Error).message}`); }
};
export const readMoltnetSqliteMigrations = (database: DatabaseSync): SqliteRow[] =>
  database.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").get()
    ? database.prepare("SELECT version, applied_at FROM schema_migrations").all() : [];
const allowedColumns: Record<string, string[]> = {
  rooms: ["id", "network_id", "fqid", "name", "created_at", "deleted_at", "visibility", "write_policy", "federation"],
  room_members: ["room_id", "member_id"],
  threads: ["id", "network_id", "fqid", "room_id", "parent_message_id", "message_count", "last_message_at"],
  messages: ["id", "network_id", "target_kind", "room_id", "thread_id", "parent_message_id", "dm_id", "target_json",
    "from_json", "parts_json", "mentions_json", "created_at", "origin_json"],
  dm_conversations: ["dm_id", "network_id", "fqid", "message_count", "last_message_at"],
  dm_participants: ["dm_id", "participant_id"],
  artifacts: ["id", "network_id", "fqid", "message_id", "target_kind", "room_id", "thread_id", "dm_id", "target_json",
    "part_index", "kind", "media_type", "filename", "url", "created_at"],
  agents: ["agent_id", "network_id", "actor_uid", "actor_uri", "display_name", "credential_key", "created_at", "updated_at"],
  attachment_delivery_events: ["seq", "event_id", "event_json", "created_at"],
  attachment_delivery_cursors: ["agent_id", "event_seq", "updated_at"],
  schema_migrations: ["version", "name", "applied_at"], sqlite_sequence: ["name", "seq"]
};

/** A snapshot is an offline store: unknown tables, views or triggers cannot be safely rewound. */
export const validateSqliteLayout = (database: DatabaseSync): void => {
  for (const row of database.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger')").all()) {
    const table = sqliteText(row, "name");
    if (row.type !== "table" || !Object.hasOwn(allowedColumns, table)) {
      throw new Error(`Unsupported Moltnet SQLite ${row.type} ${row.name}; cannot establish its historical contents`);
    }
    for (const column of database.prepare(`PRAGMA table_info(${table})`).all()) {
      if (!allowedColumns[table]!.includes(sqliteText(column, "name"))) {
        throw new Error(`Unsupported Moltnet SQLite column ${table}.${column.name}; cannot establish its historical contents`);
      }
    }
  }
};

export const readMoltnetSqlite = (database: DatabaseSync): MoltnetSnapshot => {
  validateSqliteLayout(database);
  const rooms: Record<string, unknown> = {}, removed: Record<string, unknown> = {}, threads: Record<string, unknown> = {};
  const roomMessages: Record<string, unknown[]> = {}, threadMessages: Record<string, unknown[]> = {}, directMessages: Record<string, unknown[]> = {};
  const directMembers: Record<string, Record<string, object>> = {}, agents: Record<string, unknown> = {};
  const roomMembers = database.prepare("SELECT room_id, member_id FROM room_members").all();
  for (const row of database.prepare("SELECT * FROM rooms").all()) {
    const id = sqliteText(row, "id");
    rooms[id] = { id, network_id: row.network_id, fqid: row.fqid, name: row.name, created_at: row.created_at,
      members: roomMembers.filter((member) => member.room_id === id).map((member) => member.member_id),
      ...(row.visibility !== undefined ? { visibility: row.visibility } : {}),
      ...(row.write_policy !== undefined ? { write_policy: row.write_policy } : {}),
      ...(row.federation !== undefined ? { federation: sqliteJson(row, "federation") } : {}) };
    if (row.deleted_at !== null && row.deleted_at !== undefined && row.deleted_at !== "") removed[id] = row.deleted_at;
  }
  for (const row of database.prepare("SELECT * FROM threads").all()) threads[sqliteText(row, "id")] = {
    id: row.id, network_id: row.network_id, fqid: row.fqid, room_id: row.room_id,
    parent_message_id: row.parent_message_id, message_count: row.message_count, last_message_at: row.last_message_at
  };
  // rowid preserves append order for a DM's first/root message; random message IDs do not.
  for (const row of database.prepare("SELECT * FROM messages ORDER BY rowid").all()) {
    const target = sqliteJson(row, "target_json") as Record<string, unknown>;
    for (const [column, key] of [["target_kind", "kind"], ["room_id", "room_id"], ["thread_id", "thread_id"],
      ["parent_message_id", "parent_message_id"], ["dm_id", "dm_id"]]) {
      if ((row[column] ?? "") !== (target?.[key] ?? "")) throw new Error(`Moltnet SQLite message ${row.id}: ${column} disagrees with target_json`);
    }
    const message = { id: row.id, network_id: row.network_id, target,
      from: sqliteJson(row, "from_json"), parts: sqliteJson(row, "parts_json"), mentions: sqliteJson(row, "mentions_json"),
      created_at: row.created_at, ...(row.origin_json !== undefined && row.origin_json !== "{}"
        ? { origin: sqliteJson(row, "origin_json") } : {}) };
    const group = row.target_kind === "room" ? roomMessages : row.target_kind === "thread" ? threadMessages
      : row.target_kind === "dm" ? directMessages : undefined;
    if (!group) throw new Error(`Unknown Moltnet SQLite message target kind ${row.target_kind}`);
    const key = sqliteText(row, row.target_kind === "room" ? "room_id" : row.target_kind === "thread" ? "thread_id" : "dm_id");
    (group[key] ??= []).push(message);
  }
  for (const row of database.prepare("SELECT dm_id, participant_id FROM dm_participants").all()) {
    (directMembers[sqliteText(row, "dm_id")] ??= {})[sqliteText(row, "participant_id")] = {};
  }
  for (const row of database.prepare("SELECT * FROM agents").all()) agents[sqliteText(row, "agent_id")] = {
    ...row, ...(row.display_name === null ? { display_name: "" } : {})
  };
  const eventRows = database.prepare("SELECT * FROM attachment_delivery_events ORDER BY seq").all();
  const events = eventRows.map((row) => {
    const event = moltnetEventSchema.parse(sqliteJson(row, "event_json"));
    if (event.id !== row.event_id) throw new Error(`Moltnet SQLite event ${row.event_id} disagrees with event_json`);
    return event;
  });
  const cursors = Object.fromEntries(database.prepare("SELECT * FROM attachment_delivery_cursors").all()
    .map((row) => [sqliteText(row, "agent_id"), eventRows.filter((event) => sqliteInteger(event, "seq") <= sqliteInteger(row, "event_seq")).length]));
  return parseMoltnetSnapshot({ rooms, removed_rooms: removed, threads, room_messages: roomMessages,
    thread_messages: threadMessages, direct_messages: directMessages, direct_members: directMembers,
    agents, attachment_delivery_events: events, attachment_delivery_cursors: cursors });
};
