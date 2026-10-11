import { z } from "zod";
import { instantNanos } from "./instant.js";

const text = z.string();
const id = text.min(1);
export const moltnetInstantSchema = text.refine((value) => {
  try { instantNanos(value); return true; } catch { return false; }
}, "Expected an RFC3339 instant with at most nanosecond precision");
const instant = moltnetInstantSchema;
const strings = z.array(text);
const actor = z.object({ type: id, id, name: text.optional(), network_id: text.optional(),
  fqid: text.optional(), credential_bound: z.boolean().optional() }).strict();
const target = z.object({ kind: z.enum(["room", "thread", "dm"]), room_id: text.optional(),
  thread_id: text.optional(), parent_message_id: text.optional(), dm_id: text.optional(),
  participant_ids: strings.optional() }).strict();
const part = z.object({ kind: id, text: text.optional(), media_type: text.optional(),
  url: text.optional(), filename: text.optional(), data: z.record(text, z.unknown()).optional() }).strict();

export const moltnetMessageSchema = z.object({
  id, network_id: text, origin: z.object({ network_id: text, message_id: text,
    received_via: text.optional() }).strict().optional(), target, from: actor,
  parts: z.array(part).nullable(), mentions: strings.nullable().optional(), created_at: instant
}).strict();
export const moltnetRoomSchema = z.object({
  id, network_id: text.optional(), fqid: text.optional(), name: text,
  members: strings.nullable().optional(), visibility: text.optional(), write_policy: text.optional(),
  federation: z.union([z.enum(["all", "none"]), strings]).nullable().optional(),
  access: z.object({ can_read: z.boolean(), can_write: z.boolean(), reason: text.optional() }).strict().optional(),
  created_at: instant
}).strict();
export const moltnetThreadSchema = z.object({
  id, network_id: text.optional(), fqid: text.optional(), room_id: id,
  parent_message_id: text.optional(), message_count: z.number().int().nonnegative(),
  last_message_at: instant.optional()
}).strict();
const direct = z.object({ id, network_id: text.optional(), fqid: text.optional(),
  participant_ids: strings.optional(), message_count: z.number().int().nonnegative(),
  last_message_at: instant.optional() }).strict();
const agentEvent = z.object({ agent_id: id, network_id: text.optional(), fqid: text.optional(),
  name: text.optional(), message_id: text.optional(), reason: text.optional(), target: target.optional(),
  error: text.optional(), attempts: z.number().int().optional(), classification: text.optional() }).strict();
const pairing = z.object({ id, remote_network_id: text, remote_network_name: text.optional(),
  remote_base_url: text.optional(), status: text.optional(), token: text.optional(),
  relay: z.object({ url: text, room: text.optional(), token: text.optional() }).strict().optional(),
  diagnostics: z.object({ checked_at: instant.optional(), remote_version: text.optional(),
    remote_network_id: text.optional(), remote_protocols: z.object({
      http: strings.optional(), attach: strings.optional(), pair: strings.optional()
    }).strict().optional(), reason: text.optional(), message: text.optional() }).strict().optional()
}).strict();
export const moltnetEventSchema = z.object({ id, type: id, network_id: text,
  agent: agentEvent.optional(), message: moltnetMessageSchema.optional(), room: moltnetRoomSchema.optional(),
  thread: moltnetThreadSchema.optional(), dm: direct.optional(), pairing: pairing.optional(),
  replay_gap: z.object({ requested_event_id: text.optional(), oldest_event_id: text.optional(),
    newest_event_id: text.optional() }).strict().optional(), created_at: instant
}).strict();
const registration = z.object({ network_id: text, agent_id: id, actor_uid: text, actor_uri: text,
  display_name: text.optional(), credential_key: text.optional(), created_at: instant.optional(),
  updated_at: instant.optional() }).strict();
const map = <T extends z.ZodType>(value: T) => z.record(text, value).nullable().transform((v) => v ?? {});
const messages = map(z.array(moltnetMessageSchema).nullable().transform((v) => v ?? []));
export const moltnetSnapshotSchema = z.object({
  rooms: map(moltnetRoomSchema), removed_rooms: map(instant).optional().default({}),
  room_messages: messages, threads: map(moltnetThreadSchema), thread_messages: messages,
  direct_messages: messages, direct_members: map(map(z.object({}).strict())),
  agents: map(registration).optional().default({}),
  attachment_delivery_events: z.array(moltnetEventSchema).nullable().optional().transform((v) => v ?? []),
  attachment_delivery_cursors: map(z.number().int().nonnegative()).optional().default({})
}).strict();

export type MoltnetSnapshot = z.infer<typeof moltnetSnapshotSchema>;
export type MoltnetMessage = z.infer<typeof moltnetMessageSchema>;
export type MoltnetEvent = z.infer<typeof moltnetEventSchema>;
export interface MoltnetFinding {
  class: "moltnet-message" | "moltnet-event" | "moltnet-room";
  path: string;
  detail: string;
}
export interface MoltnetInspection { messages: number; events: number; findings: MoltnetFinding[] }
