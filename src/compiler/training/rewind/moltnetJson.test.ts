import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { materializeMoltnet } from "./moltnet.js";
import { momentRecordSchema } from "../../../recording/index.js";
import { openHistory } from "./history.js";
import { emptyMoltnetSnapshot, inspectMoltnetJson, moltnetMessages, parseMoltnetSnapshot, rewindMoltnetJson } from "./moltnetJson.js";
import type { MoltnetMessage } from "./moltnetSchemas.js";
import type { InputContext } from "./types.js";

const at = "2026-10-09T10:00:00.1Z", before = "2026-10-09T10:00:00Z", future = "2026-10-09T10:00:00.11Z";
const network = { id: "news", provider: "moltnet" as const, rooms: [{ id: "assignment", members: ["writer"] }] };
const message = (id: string, created_at: string, target: MoltnetMessage["target"] = { kind: "room", room_id: "assignment" }): MoltnetMessage =>
  ({ id, network_id: "news", from: { type: "agent", id: "writer" }, target, parts: [{ kind: "text", text: id }], created_at });
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("Moltnet JSON rewind", () => {
  it("round-trips an empty actor type through the JSON cut unchanged and refuses a missing actor id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rewind-moltnet-actor-")); temps.push(root);
    const bank = path.join(root, "moltnet/team%3Aorg/news"); await mkdir(bank, { recursive: true });
    const source = emptyMoltnetSnapshot(network, before);
    const operator = { ...message("operator-message", before), from: { type: "", id: "operator" }, parts: [{ kind: "text" }] };
    const delivery = { id: "operator-event", type: "message.created", network_id: "news", created_at: before, message: operator };
    source.room_messages.assignment = [operator, message("future", future)];
    source.attachment_delivery_events = [delivery]; source.attachment_delivery_cursors = { writer: 1 };
    const file = path.join(bank, "state.json"), bytes = JSON.stringify(source);
    await writeFile(file, bytes);
    const context: InputContext = { at, record: null, history: await openHistory(root), destination: path.join(root, "out"),
      input: { section: "networks", id: "news", declaredBy: "team:org", overridden: false, declarationBase: root, declaration: network } };
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "approximate", basis: "created-at-cut" });
    const output = path.join(context.destination, "state.json"), cut = JSON.parse(await readFile(output, "utf8"));
    expect(cut.room_messages.assignment).toEqual([operator]);
    expect(cut.attachment_delivery_events).toEqual([delivery]);
    expect(cut.attachment_delivery_cursors).toEqual({ writer: 1 });
    expect(await inspectMoltnetJson(output, at)).toMatchObject({ messages: 1, events: 1, findings: [] });
    expect(await readFile(file, "utf8")).toBe(bytes);
    for (const from of [{ type: "" }, { type: "", id: "" }]) {
      const malformed = JSON.parse(bytes); malformed.room_messages.assignment[0].from = from;
      await writeFile(file, JSON.stringify(malformed));
      await expect(materializeMoltnet(context)).rejects.toThrow(/"id"/);
      await expect(inspectMoltnetJson(file, at)).rejects.toThrow(/"id"/);
    }
  });

  it("cuts RFC3339Nano times chronologically, removes future topology, recomputes counters and remaps delivery cursors", () => {
    const source = emptyMoltnetSnapshot(network, before);
    source.room_messages.assignment = [message("old", before), message("boundary", at), message("future", future)];
    source.rooms.later = { id: "later", name: "later", created_at: future };
    source.room_messages.later = [message("regressed-room", before, { kind: "room", room_id: "later" })];
    for (const [id, parent] of [["kept", "old"], ["dropped", "future"]]) {
      source.threads[id] = { id, room_id: "assignment", parent_message_id: parent, message_count: 99, last_message_at: future };
      source.thread_messages[id] = [message(`${id}-old`, before, { kind: "thread", room_id: "assignment", thread_id: id }),
        message(`${id}-future`, future, { kind: "thread", room_id: "assignment", thread_id: id })];
    }
    source.direct_messages.dm = [message("dm-root-future", future, { kind: "dm", dm_id: "dm" }),
      message("dm-regression", before, { kind: "dm", dm_id: "dm" })];
    source.direct_members.dm = { writer: {}, brass: {} };
    source.attachment_delivery_events = [
      { id: "e1", type: "message.created", network_id: "news", created_at: before, message: message("old", before) },
      { id: "e2", type: "message.created", network_id: "news", created_at: future, message: message("future", future) },
      { id: "e3", type: "message.created", network_id: "news", created_at: at, message: message("boundary", at) }
    ];
    source.attachment_delivery_cursors = { writer: 3, brass: 2 };
    const cut = rewindMoltnetJson(source, at);
    expect(Object.keys(cut.rooms)).toEqual(["assignment"]);
    expect(cut.threads.kept).toMatchObject({ message_count: 1, last_message_at: before });
    expect(cut.threads.dropped).toBeUndefined(); expect(cut.direct_messages).toEqual({}); expect(cut.direct_members).toEqual({});
    expect(cut.attachment_delivery_events.map((event) => event.id)).toEqual(["e1", "e3"]);
    expect(cut.attachment_delivery_cursors).toEqual({ writer: 2, brass: 1 });
    expect(moltnetMessages(cut).map((entry) => entry.id)).toEqual(["old", "boundary", "kept-old"]);
    expect(source.threads.kept?.message_count).toBe(99);
  });

  it("restores known later removals, keeps zero-time unknown removals and refuses missing restoration metadata", () => {
    const source = emptyMoltnetSnapshot(network, before);
    source.removed_rooms.assignment = future;
    const room = source.rooms.assignment!; delete source.rooms.assignment;
    expect(() => rewindMoltnetJson(source, at)).toThrow("room metadata was not retained");
    source.attachment_delivery_events = [{ id: "room-created", type: "room.created", network_id: "news", created_at: before, room }];
    expect(rewindMoltnetJson(source, at).rooms.assignment).toEqual(room);
    source.removed_rooms.assignment = "0001-01-01T00:00:00Z";
    expect(rewindMoltnetJson(source, at).removed_rooms.assignment).toBe("0001-01-01T00:00:00Z");
  });

  it("refuses restoration from future room events even when the embedded creation date is old", () => {
    const source = emptyMoltnetSnapshot(network, before), room = source.rooms.assignment!;
    delete source.rooms.assignment; source.removed_rooms.assignment = future;
    source.attachment_delivery_events = [{ id: "future-room", type: "room.updated", network_id: "news", created_at: future,
      room: { ...room, name: "FUTURE ROOM NAME", members: ["future-agent"] } }];
    expect(() => rewindMoltnetJson(source, at)).toThrow("room metadata was not retained");
    source.attachment_delivery_events.push({ id: "old-room", type: "room.created", network_id: "news", created_at: before, room });
    expect(rewindMoltnetJson(source, at).rooms.assignment).toEqual(room);
  });

  it("drops future registrations with their memberships and cursors while clamping retained updates", async () => {
    const source = emptyMoltnetSnapshot(network, before);
    for (const [id, created_at, updated_at] of [["writer", before, future], ["boundary", at, at], ["later", future, future]]) {
      source.agents[id] = { agent_id: id, network_id: "news", actor_uid: id, actor_uri: id, created_at, updated_at };
    }
    source.agents.undated = { agent_id: "undated", network_id: "news", actor_uid: "undated", actor_uri: "undated" };
    source.rooms.assignment!.members = ["writer", "boundary", "later", "unregistered"];
    source.direct_messages.dm = [message("dm-old", before, { kind: "dm", dm_id: "dm" })];
    source.direct_members.dm = { writer: {}, boundary: {}, later: {}, unregistered: {} };
    source.attachment_delivery_cursors = { writer: 0, later: 0 };
    const cut = rewindMoltnetJson(source, at);
    expect(Object.keys(cut.agents)).toEqual(["writer", "boundary", "undated"]);
    expect(cut.agents.writer).toMatchObject({ created_at: before, updated_at: at });
    expect(cut.agents.boundary).toMatchObject({ created_at: at, updated_at: at });
    expect(cut.agents.undated).not.toHaveProperty("updated_at");
    expect(cut.rooms.assignment!.members).toEqual(["writer", "boundary", "unregistered"]);
    expect(cut.direct_members.dm).toEqual({ writer: {}, boundary: {}, unregistered: {} });
    expect(cut.attachment_delivery_cursors).toEqual({ writer: 0 });
    expect(source.agents.writer!.updated_at).toBe(future); expect(source.agents.later).toBeDefined();
    expect(source.rooms.assignment!.members).toContain("later"); expect(source.direct_members.dm).toHaveProperty("later");
    const root = await mkdtemp(path.join(os.tmpdir(), "rewind-moltnet-agents-")); temps.push(root);
    const file = path.join(root, "state.json"); await writeFile(file, JSON.stringify(cut));
    expect((await inspectMoltnetJson(file, at)).findings).toEqual([]);
  });

  it.each(["created_at", "updated_at"] as const)("independently flags an agent's future %s", async (field) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rewind-moltnet-agent-leak-")); temps.push(root);
    const file = path.join(root, "state.json"), source = emptyMoltnetSnapshot(network, before);
    source.agents.writer = { agent_id: "writer", network_id: "news", actor_uid: "uid", actor_uri: "uri",
      created_at: before, updated_at: before, [field]: future };
    const bytes = JSON.stringify(source); await writeFile(file, bytes);
    expect((await inspectMoltnetJson(file, at)).findings).toEqual([
      { class: "moltnet-event", path: file, detail: `Agent writer has a future ${field}` }
    ]);
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("materializes exact cursor and approximate cuts, keeps history unchanged and makes fresh overridden rooms", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rewind-moltnet-")); temps.push(root);
    const bank = path.join(root, "moltnet/team%3Aorg/news"); await mkdir(bank, { recursive: true });
    const source = emptyMoltnetSnapshot(network, before);
    source.room_messages.assignment = [message("wake", before), message("boundary", at), message("future", future)];
    const bytes = JSON.stringify(source); await writeFile(path.join(bank, "state.json"), bytes);
    const context: InputContext = { at, record: null, history: await openHistory(root), destination: path.join(root, "out"),
      input: { section: "networks", id: "news", declaredBy: "team:org", overridden: false, declarationBase: root, declaration: network } };
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "approximate", basis: "created-at-cut" });
    expect(await readFile(path.join(bank, "state.json"), "utf8")).toBe(bytes);
    expect(await inspectMoltnetJson(path.join(context.destination, "state.json"), at)).toMatchObject({ messages: 2, findings: [] });
    context.record = momentRecordSchema.parse({ version: "spawnfile.moment-record.v1", agent: "agent:writer",
      wake: { at, startedAt: at, executionId: "turn-1", deliveries: [{ deliveryId: "moltnet:wake", kind: "message", occurredAt: at }],
        surface: "moltnet", room: "assignment", from: "brass" }, recordedAt: at, exact: true,
      resources: [], feeds: [], memory: [], moltnet: [{ network: "news", cursor: at, messageIds: ["wake", "boundary"] }], volumes: [] });
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "exact", basis: "record-cursor" });
    expect(moltnetMessages(parseMoltnetSnapshot(JSON.parse(await readFile(path.join(context.destination, "state.json"), "utf8"))))
      .map((entry) => entry.id)).toEqual(["wake", "boundary"]);
    context.record.moltnet[0]!.cursor = "2026-10-09T12:00:00.100000000+02:00";
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "exact", basis: "record-cursor" });
    for (const cursor of [before, future]) {
      context.record.moltnet[0]!.cursor = cursor;
      await expect(materializeMoltnet(context)).rejects.toThrow(/cursor must equal.*startedAt/);
    }
    context.record.moltnet[0]!.cursor = at;
    for (const messageIds of [["missing"], ["wake", "future"]]) {
      context.record.moltnet[0]!.messageIds = messageIds;
      await expect(materializeMoltnet(context)).rejects.toThrow(/wake message.*not retained/);
    }
    delete context.record.moltnet[0]!.messageIds;
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "exact", basis: "record-cursor" });
    context.input.overridden = true; context.history = undefined;
    expect(await materializeMoltnet(context)).toMatchObject({ fidelity: "overridden" });
    const output = parseMoltnetSnapshot(JSON.parse(await readFile(path.join(context.destination, "state.json"), "utf8")));
    expect(output.rooms.assignment?.members).toEqual(["writer"]); expect(moltnetMessages(output)).toEqual([]);
  });

  it("independently detects mutated messages, events and rooms on disk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rewind-moltnet-leak-")); temps.push(root);
    const file = path.join(root, "state.json"), snapshot = emptyMoltnetSnapshot(network, before);
    await writeFile(file, JSON.stringify(snapshot)); expect((await inspectMoltnetJson(file, at)).findings).toEqual([]);
    snapshot.room_messages.assignment = [message("future", future)];
    snapshot.rooms.future = { id: "future", name: "future", created_at: future };
    snapshot.attachment_delivery_events = [{ id: "future", type: "message.created", network_id: "news", created_at: future }];
    await writeFile(file, JSON.stringify(snapshot));
    expect((await inspectMoltnetJson(file, at)).findings.map((finding) => finding.class)).toEqual(["moltnet-message", "moltnet-room", "moltnet-event"]);
  });
});
