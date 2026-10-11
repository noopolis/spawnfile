import { z } from "zod";
import { trainingInstantSchema } from "../manifest/index.js";
import { MOMENT_RECORD_VERSION } from "./types.js";

const text = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const recordedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const recordedCommitSchema = z.string()
  .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u, "Expected a full 40- or 64-hex commit object id")
  .toLowerCase();
const unique = <T extends z.ZodType>(schema: T, key: (item: z.infer<T>) => string) =>
  z.array(schema).superRefine((items, context) => {
    const keys = new Set<string>();
    items.forEach((item, index) => {
      const id = key(item);
      if (keys.has(id)) context.addIssue({ code: "custom", message: `Duplicate identity ${id}`, path: [index] });
      keys.add(id);
    });
  });
export const momentRecordSchema = z.object({
  version: z.literal(MOMENT_RECORD_VERSION), agent: text,
  wake: z.object({ at: trainingInstantSchema, startedAt: trainingInstantSchema, executionId: text,
    deliveries: z.array(z.object({ deliveryId: text, kind: text, occurredAt: trainingInstantSchema }).strict()).min(1),
    surface: z.literal("moltnet").optional(), room: z.string().optional(),
    from: z.string().optional(), messageId: text.optional() }).strict(),
  recordedAt: trainingInstantSchema, exact: z.boolean(), errors: z.array(z.string()).optional(),
  resources: unique(z.discriminatedUnion("kind", [
    z.object({ id: text, kind: z.literal("git"), commit: recordedCommitSchema, sha256: recordedSha256Schema.optional() }).strict(),
    z.object({ id: text, kind: z.literal("bundle"), sha256: recordedSha256Schema }).strict()
  ]), (r) => r.id),
  feeds: unique(z.object({ id: text, revision: text, tree: text, commit: recordedCommitSchema.optional(), ref: text.optional(),
    paths: z.array(text).optional(), landedAt: trainingInstantSchema, period: text.optional() }).strict(), (r) => r.id),
  memory: unique(z.object({ id: text, declaredBy: text, seq: count, generation: count.optional() }).strict(),
    (r) => JSON.stringify([r.declaredBy, r.id])),
  moltnet: unique(z.object({ network: text, cursor: trainingInstantSchema, messageIds: z.array(text).optional() }).strict(), (r) => r.network),
  volumes: unique(z.object({ id: text, snapshot: text }).strict(), (r) => r.id)
}).strict();
export type MomentRecord = z.infer<typeof momentRecordSchema>;

export const parseMomentRecord = (payload: string): MomentRecord => momentRecordSchema.parse(JSON.parse(payload));
