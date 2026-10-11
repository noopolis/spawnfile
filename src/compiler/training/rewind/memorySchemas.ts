import { z } from "zod";
import { trainingInstantSchema } from "../../../manifest/index.js";

const safeSequence = z.number().int().nonnegative().refine(Number.isSafeInteger);
const relativeLedger = z.string().min(1).refine((value) => !value.includes("\\")
  && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"ledger must be a relative path inside its bank directory");
export const memoryGenerationSchema = z.object({
  generation: safeSequence, switchedAt: trainingInstantSchema, ledger: relativeLedger
}).strict();
export type MemoryGeneration = z.infer<typeof memoryGenerationSchema>;

/** Mirrors the public MemoryEvent contract and Mneme 0.1.1's strict ledger reader. */
export const memoryEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["memory.observed", "memory.claimed", "memory.registered", "memory.summarized",
    "memory.recalled", "memory.located", "memory.denied", "memory.forgotten", "memory.promoted", "memory.consolidated"]),
  createdAt: trainingInstantSchema,
  principal: z.object({ agentId: z.string().min(1),
    scope: z.enum(["global", "team", "room", "pair", "task", "role", "artifact"]), qualifier: z.string().optional()
  }).strict(),
  scope: z.string(), visibility: z.enum(["private", "pair", "team", "room", "global", "public", "sealed"]),
  source: z.string(),
  content: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }).strict(),
    z.object({ kind: z.literal("claim"), subject: z.string(), predicate: z.string(), object: z.string() }).strict(),
    z.object({ kind: z.literal("decision"), decision: z.string(), rationale: z.string().optional() }).strict(),
    z.object({ kind: z.literal("artifact"), description: z.string(), path: z.string().optional(), uri: z.string().optional() }).strict(),
    z.object({ kind: z.literal("relationship"), from: z.string(), relation: z.string(), to: z.string() }).strict()
  ]),
  tags: z.array(z.string()), entities: z.array(z.string()),
  sensitivity: z.enum(["normal", "sensitive", "secret"]), confidence: z.number().finite().optional(),
  ttl: z.string().optional(), parentEventIds: z.array(z.string()), checksum: z.string().min(1),
  seq: safeSequence.refine((value) => value > 0).optional(), memoryId: z.string().optional(),
  origin: z.enum(["awake", "dream", "system"]).optional(), highWaterSeq: safeSequence.optional()
}).strict();
export type MemoryLedgerEvent = z.infer<typeof memoryEventSchema>;
