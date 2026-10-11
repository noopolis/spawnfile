import { readFile } from "node:fs/promises";
import type { TeamNetwork } from "../../../manifest/index.js";
import { compareInstants } from "./instant.js";
import { moltnetSnapshotSchema, type MoltnetSnapshot, type MoltnetEvent,
  type MoltnetMessage, type MoltnetInspection, type MoltnetFinding } from "./moltnetSchemas.js";

export const moltnetMessages = (snapshot: MoltnetSnapshot): MoltnetMessage[] =>
  [snapshot.room_messages, snapshot.thread_messages, snapshot.direct_messages]
    .flatMap((group) => Object.values(group).flat());

export const parseMoltnetSnapshot = (value: unknown): MoltnetSnapshot => {
  const snapshot = moltnetSnapshotSchema.parse(value);
  const ids = new Set<string>();
  for (const message of moltnetMessages(snapshot)) {
    if (ids.has(message.id)) throw new Error(`Moltnet snapshot has duplicate message ${message.id}`);
    ids.add(message.id);
  }
  for (const group of [snapshot.rooms, snapshot.threads]) {
    for (const [id, value] of Object.entries(group)) {
      if (id !== value.id) throw new Error(`Moltnet snapshot key ${id} disagrees with id ${value.id}`);
    }
  }
  return snapshot;
};

export const emptyMoltnetSnapshot = (network: TeamNetwork, at: string): MoltnetSnapshot =>
  parseMoltnetSnapshot({
    rooms: Object.fromEntries(network.rooms.map((room) => [room.id, {
      ...room, name: room.name ?? room.id, network_id: network.id,
      fqid: `molt://${network.id}/rooms/${room.id}`, created_at: at
    }])), removed_rooms: {}, room_messages: {}, threads: {}, thread_messages: {},
    direct_messages: {}, direct_members: {}, agents: {}, attachment_delivery_events: [],
    attachment_delivery_cursors: {}
  });

export const latestMoltnetMessage = <T extends { created_at: string }>(messages: T[]): T | undefined =>
  messages.reduce<T | undefined>((latest, item) => !latest
    || compareInstants(item.created_at, latest.created_at) > 0 ? item : latest, undefined);

const eventFuture = (event: MoltnetEvent, at: string): boolean => [event.created_at,
  event.message?.created_at, event.room?.created_at, event.thread?.last_message_at,
  event.dm?.last_message_at, event.pairing?.diagnostics?.checked_at]
  .some((instant) => instant !== undefined && compareInstants(instant, at) > 0);

/** Pure cut. Delivery offsets must be remapped after removing interior future events. */
export const rewindMoltnetJson = (source: MoltnetSnapshot, at: string): MoltnetSnapshot => {
  const snapshot = structuredClone(source);
  const futureRooms = new Set(Object.values(source.rooms)
    .filter((room) => compareInstants(room.created_at, at) > 0).map((room) => room.id));
  for (const id of futureRooms) {
    delete snapshot.rooms[id]; delete snapshot.room_messages[id]; delete snapshot.removed_rooms[id];
  }
  for (const [id, removedAt] of Object.entries(snapshot.removed_rooms)) {
    if (compareInstants(removedAt, at) <= 0) continue;
    if (!snapshot.rooms[id]) {
      const candidates = source.attachment_delivery_events.filter((event) => event.room?.id === id
        && compareInstants(event.room.created_at, at) <= 0)
        .sort((a, b) => compareInstants(b.created_at, a.created_at));
      const room = candidates.find((event) => compareInstants(event.created_at, at) <= 0)?.room
        ?? candidates[0]?.room;
      if (!room) throw new Error(`Cannot restore Moltnet room ${id}: removal is after the moment but room metadata was not retained`);
      snapshot.rooms[id] = structuredClone(room);
    }
    delete snapshot.removed_rooms[id];
  }
  for (const group of [snapshot.room_messages, snapshot.thread_messages, snapshot.direct_messages]) {
    for (const [id, messages] of Object.entries(group)) {
      group[id] = messages.filter((message) => compareInstants(message.created_at, at) <= 0
        && !futureRooms.has(message.target.room_id ?? ""));
    }
  }
  // A removed root can itself belong to a removed thread; resolve until no dangling root remains.
  let changed = true;
  while (changed) {
    changed = false;
    const retainedIds = new Set(moltnetMessages(snapshot).map((message) => message.id));
    for (const [id, thread] of Object.entries(snapshot.threads)) {
      const messages = snapshot.thread_messages[id] ?? [];
      const root = source.thread_messages[id]?.[0];
      if (!messages.length || futureRooms.has(thread.room_id)
        || (thread.parent_message_id && !retainedIds.has(thread.parent_message_id))
        || (!thread.parent_message_id && root && compareInstants(root.created_at, at) > 0)) {
        delete snapshot.threads[id]; delete snapshot.thread_messages[id]; changed = true;
      } else {
        thread.message_count = messages.length;
        thread.last_message_at = latestMoltnetMessage(messages)!.created_at;
      }
    }
  }
  for (const id of Object.keys(snapshot.thread_messages)) {
    if (!snapshot.threads[id]) delete snapshot.thread_messages[id];
  }
  for (const [id, messages] of Object.entries(snapshot.direct_messages)) {
    const root = source.direct_messages[id]?.[0];
    if (!messages.length || (root && compareInstants(root.created_at, at) > 0)) {
      delete snapshot.direct_messages[id]; delete snapshot.direct_members[id];
    }
  }
  for (const id of Object.keys(snapshot.direct_members)) {
    if (!snapshot.direct_messages[id]) delete snapshot.direct_members[id];
  }
  const finalIds = new Set(moltnetMessages(snapshot).map((message) => message.id));
  const retainedEvents = source.attachment_delivery_events.map((event, index) => ({ event, index }))
    .filter(({ event }) => !eventFuture(event, at)
      && (!event.message || finalIds.has(event.message.id))
      && (!event.room || !futureRooms.has(event.room.id))
      && (!event.thread || Boolean(snapshot.threads[event.thread.id]))
      && (!event.dm || Boolean(snapshot.direct_messages[event.dm.id])));
  snapshot.attachment_delivery_events = retainedEvents.map(({ event }) => event);
  for (const [agent, cursor] of Object.entries(snapshot.attachment_delivery_cursors)) {
    snapshot.attachment_delivery_cursors[agent] = retainedEvents.filter(({ index }) => index < cursor).length;
  }
  return snapshot;
};

/** UUID cursors have no ordering: exactness is established only from the retained message instant. */
export const moltnetCursorExact = (messages: Array<{ id: string; created_at: string }>, cursor?: string): boolean => {
  const message = cursor === undefined ? undefined : messages.find((entry) => entry.id === cursor);
  return Boolean(message && messages.every((entry) => compareInstants(entry.created_at, message.created_at) <= 0));
};

/** Independent timestamp inspection of event payloads, including embedded messages and rooms. */
export const inspectMoltnetEvent = (event: MoltnetEvent, at: string, path: string): MoltnetFinding[] => {
  const findings: MoltnetFinding[] = [];
  const check = (instant: string | undefined, kind: MoltnetFinding["class"], detail: string) => {
    if (instant !== undefined && compareInstants(instant, at) > 0) findings.push({ class: kind, path, detail });
  };
  check(event.created_at, "moltnet-event", `Attachment event ${event.id} is later than the moment`);
  check(event.message?.created_at, "moltnet-message", `Event ${event.id} contains a future message`);
  check(event.room?.created_at, "moltnet-room", `Event ${event.id} contains a future room`);
  check(event.thread?.last_message_at, "moltnet-event", `Event ${event.id} contains a future thread counter`);
  check(event.dm?.last_message_at, "moltnet-event", `Event ${event.id} contains a future DM counter`);
  check(event.pairing?.diagnostics?.checked_at, "moltnet-event", `Event ${event.id} contains future pairing diagnostics`);
  return findings;
};

export const inspectMoltnetJson = async (path: string, at: string): Promise<MoltnetInspection> => {
  const snapshot = parseMoltnetSnapshot(JSON.parse(await readFile(path, "utf8")));
  const findings: MoltnetFinding[] = [];
  const messages = moltnetMessages(snapshot);
  for (const message of messages) if (compareInstants(message.created_at, at) > 0) {
    findings.push({ class: "moltnet-message", path, detail: `Message ${message.id} is later than the moment` });
  }
  for (const room of Object.values(snapshot.rooms)) if (compareInstants(room.created_at, at) > 0) {
    findings.push({ class: "moltnet-room", path, detail: `Room ${room.id} is later than the moment` });
  }
  for (const thread of Object.values(snapshot.threads)) {
    if (thread.last_message_at && compareInstants(thread.last_message_at, at) > 0) {
      findings.push({ class: "moltnet-message", path, detail: `Thread ${thread.id} has a future counter` });
    }
  }
  for (const [id, instant] of Object.entries(snapshot.removed_rooms)) {
    if (compareInstants(instant, at) > 0) findings.push({ class: "moltnet-room", path,
      detail: `Room ${id} has a future removal marker` });
  }
  for (const event of snapshot.attachment_delivery_events) findings.push(...inspectMoltnetEvent(event, at, path));
  return { messages: messages.length, events: snapshot.attachment_delivery_events.length, findings };
};
