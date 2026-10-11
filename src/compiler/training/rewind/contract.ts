import { z } from "zod";
import { trainingInstantSchema } from "../../../manifest/index.js";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
export const inputIdentitySchema = z.object({
  section: z.enum(["resources", "memory", "networks"]), id: text, declaredBy: text
}).strict();
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
  version: z.literal("spawnfile.moment-record.v1"), agent: text,
  wake: z.object({ at: trainingInstantSchema, surface: z.literal("moltnet"), room: z.string(),
    from: z.string(), messageId: text.optional() }).strict(),
  recordedAt: trainingInstantSchema,
  resources: unique(z.object({ id: text, kind: z.enum(["git", "bundle"]), commit: text }).strict(), (r) => r.id),
  feeds: unique(z.object({ id: text, revision: text, tree: text, commit: text,
    paths: z.array(text), landedAt: trainingInstantSchema }).strict(), (r) => r.id),
  memory: unique(z.object({ id: text, declaredBy: text, seq: count, generation: count }).strict(),
    (r) => JSON.stringify([r.declaredBy, r.id])),
  moltnet: unique(z.object({ network: text, cursor: text }).strict(), (r) => r.network),
  volumes: unique(z.object({ id: text, snapshot: text }).strict(), (r) => r.id)
}).strict();
export type MomentRecord = z.infer<typeof momentRecordSchema>;

export const materializedInputSchema = inputIdentitySchema.extend({
  kind: z.enum(["git", "bundle", "feed", "volume", "memory", "moltnet"]),
  fidelity: z.enum(["exact", "approximate", "overridden"]).nullable(), basis: text,
  source: z.object({ commit: text.optional(), revision: text.optional(), seq: count.optional(),
    generation: count.optional(), snapshot: text.optional(), cursor: text.optional() }).strict(),
  path: text.nullable(), notes: z.array(z.string()), refusal: text.nullable(), build: z.literal("deferred").optional()
}).strict();
export type MaterializedInput = z.infer<typeof materializedInputSchema>;
export const materializedMomentSchema = z.object({
  version: z.literal("spawnfile.materialized-moment.v1"), status: z.enum(["materialized", "refused"]),
  agent: text, example: z.object({ id: text, role: z.enum(["train", "validation", "test"]), dataset: text }).strict(),
  at: trainingInstantSchema, inputs: z.array(materializedInputSchema), record: z.object({ matched: z.boolean() }).strict(),
  leakCheck: z.object({ ok: z.boolean(), findings: count }).strict()
}).strict();
export type MaterializedMoment = z.infer<typeof materializedMomentSchema>;
export const leakFindingSchema = z.object({
  input: inputIdentitySchema.nullable(),
  class: z.enum(["file-time", "symlink-escape", "git-object", "memory-event", "moltnet-message",
    "moltnet-event", "moltnet-room", "feed-identity", "dated-path", "snapshot"]), path: text, detail: text
}).strict();
export const leakCheckSchema = z.object({
  version: z.literal("spawnfile.leak-check.v1"), at: trainingInstantSchema, ok: z.boolean(),
  checked: z.object({ files: count, gitObjects: count, memoryEvents: count, moltnetMessages: count,
    moltnetEvents: count, snapshots: count }).strict(), findings: z.array(leakFindingSchema)
}).strict();
export type LeakCheck = z.infer<typeof leakCheckSchema>;
export type LeakFinding = z.infer<typeof leakFindingSchema>;
export const taskClockSchema = z.object({ version: z.literal("spawnfile.task-clock.v1"), origin: trainingInstantSchema }).strict();
export const materializedMomentJsonSchema = z.toJSONSchema(materializedMomentSchema);
export const leakCheckJsonSchema = z.toJSONSchema(leakCheckSchema);
export const taskClockJsonSchema = z.toJSONSchema(taskClockSchema);
