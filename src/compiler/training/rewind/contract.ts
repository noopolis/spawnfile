import { z } from "zod";
import { trainingInstantSchema } from "../../../manifest/index.js";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
export const recordedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const recordedCommitSchema = z.string()
  .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u, "Expected a full 40- or 64-hex commit object id")
  .toLowerCase();
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

export const materializedInputSchema = inputIdentitySchema.extend({
  kind: z.enum(["git", "bundle", "feed", "volume", "memory", "moltnet"]),
  fidelity: z.enum(["exact", "approximate", "overridden"]).nullable(), basis: text,
  source: z.object({ commit: text.optional(), repository: text.optional(), revision: text.optional(), seq: count.optional(),
    sha256: recordedSha256Schema.optional(), agentSlug: text.optional(), snapshot: text.optional(), cursor: text.optional(),
    switchingAt: trainingInstantSchema.optional(), landedAt: trainingInstantSchema.optional() }).strict(),
  path: text.nullable(), notes: z.array(z.string()), refusal: text.nullable(), build: z.literal("deferred").optional()
}).strict();
export type MaterializedInput = z.infer<typeof materializedInputSchema>;
export const materializedMomentSchema = z.object({
  version: z.literal("spawnfile.materialized-moment.v1"), status: z.enum(["materialized", "refused"]),
  agent: text, example: z.object({ id: text, role: z.enum(["train", "validation", "test"]), dataset: text }).strict(),
  at: trainingInstantSchema, effectiveAt: trainingInstantSchema, inputs: z.array(materializedInputSchema),
  record: z.object({ matched: z.boolean(), attempts: count.optional(), selectedStartedAt: trainingInstantSchema.optional(),
    executionId: text.optional(), selection: z.literal("earliest-startedAt").optional() }).strict(),
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
