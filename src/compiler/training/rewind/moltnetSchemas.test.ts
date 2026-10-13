import { describe, expect, it } from "vitest";
import { moltnetEventSchema, moltnetMessageSchema, moltnetRoomSchema,
  moltnetSnapshotSchema, moltnetThreadSchema } from "./moltnetSchemas.js";

const at = "2026-10-09T10:00:00Z";
const message = { id: "message", network_id: "", target: { kind: "room", room_id: "room" },
  from: { type: "", id: "operator" }, parts: [{ kind: "text" }], created_at: at };

describe("Moltnet native schemas", () => {
  it("preserves empty, unvalidated wire strings and omitted optional message fields", () => {
    expect(moltnetMessageSchema.parse(message)).toEqual(message);
    const populated = { ...message, origin: { network_id: "", message_id: "", received_via: "" },
      from: { ...message.from, name: "", network_id: "", fqid: "", credential_bound: false },
      parts: [{ kind: "file", text: "", media_type: "", url: "", filename: "", data: {} }], mentions: [] };
    expect(moltnetMessageSchema.parse(populated)).toEqual(populated);
  });

  it("accepts optional topology, event payload and delivery fields without inventing values", () => {
    const room = { id: "room", name: "", created_at: at };
    const thread = { id: "thread", room_id: "room", message_count: 0 };
    const dm = { id: "dm", message_count: 0 };
    const event = { id: "event", type: "", network_id: "", created_at: at };
    expect(moltnetRoomSchema.parse(room)).toEqual(room);
    expect(moltnetThreadSchema.parse(thread)).toEqual(thread);
    expect(moltnetEventSchema.parse(event)).toEqual(event);
    const embedded = { ...event, message, room, thread, dm, agent: { agent_id: "operator" }, replay_gap: {},
      pairing: { id: "pairing", remote_network_id: "", relay: { url: "" }, diagnostics: {} } };
    expect(moltnetEventSchema.parse(embedded)).toEqual(embedded);
    const snapshot = moltnetSnapshotSchema.parse({ rooms: { room }, room_messages: { room: [message] },
      threads: {}, thread_messages: {}, direct_messages: {}, direct_members: {} });
    expect(snapshot.attachment_delivery_events).toEqual([]);
    expect(snapshot.attachment_delivery_cursors).toEqual({});
  });

  it.each([{ type: "" }, { type: "", id: "" }, { type: "", id: 1 }, { id: "operator" },
    { type: null, id: "operator" }, { type: "", id: "operator", unknown: true }])(
    "refuses a malformed actor %j", (from) => {
      expect(() => moltnetMessageSchema.parse({ ...message, from })).toThrow();
      expect(() => moltnetEventSchema.parse({ id: "event", type: "", network_id: "", created_at: at,
        message: { ...message, from } })).toThrow();
    });

  it("keeps required identities, part kinds, timestamps and delivery offsets strict", () => {
    const valid = { ...message, from: { type: "agent", id: "operator" } };
    for (const patch of [{ id: "" }, { id: undefined }, { parts: [{ kind: "" }] },
      { created_at: "" }, { network_id: 1 }]) {
      expect(() => moltnetMessageSchema.parse({ ...valid, ...patch })).toThrow();
    }
    expect(() => moltnetRoomSchema.parse({ id: "", name: "", created_at: at })).toThrow();
    expect(() => moltnetThreadSchema.parse({ id: "thread", room_id: "", message_count: 0 })).toThrow();
    expect(() => moltnetEventSchema.parse({ id: "", type: "message.created", network_id: "", created_at: at })).toThrow();
    for (const cursor of [-1, 0.5, "0"]) expect(() => moltnetSnapshotSchema.parse({ rooms: {}, room_messages: {},
      threads: {}, thread_messages: {}, direct_messages: {}, direct_members: {},
      attachment_delivery_cursors: { operator: cursor } })).toThrow();
  });
});
