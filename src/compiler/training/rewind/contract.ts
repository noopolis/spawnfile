import { z } from "zod";
import { recordedSha256Schema } from "../../../recording/index.js";
import { trainingInstantSchema } from "../../../manifest/index.js";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
export const inputIdentitySchema = z.object({
  section: z.enum(["resources", "memory", "networks"]), id: text, declaredBy: text
}).strict();
export const materializedInputSchema = inputIdentitySchema.extend({
  kind: z.enum(["git", "bundle", "feed", "volume", "memory", "moltnet"]),
  fidelity: z.enum(["exact", "approximate", "overridden"]).nullable(), basis: text,
  source: z.object({ commit: text.optional(), repository: text.optional(), revision: text.optional(), seq: count.optional(),
    trees: z.array(z.object({ root: z.string(), prefix: z.string().optional(), exclude: z.array(text).optional() }).strict()).min(1).optional(),
    sha256: recordedSha256Schema.optional(), agentSlug: text.optional(), snapshot: text.optional(), cursor: text.optional(),
    switchingAt: trainingInstantSchema.optional(), landedAt: trainingInstantSchema.optional(), prepared: z.literal(true).optional() }).strict(),
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
  class: z.enum(["bundle-entry", "file-time", "symlink-escape", "git-object", "memory-event", "moltnet-message",
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
