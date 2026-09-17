import path from "node:path";
import { z } from "zod";
import { trainingContextSchema } from "../contract.js";
import { trainingPreparationSchema, trainingBuildSchema } from "../preparation/contract.js";

export const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const relative = z.string().min(1).refine(value => !path.posix.isAbsolute(value) && !value.includes("\\") &&
  value.split("/").every(part => part !== "." && part !== ".." && part !== ""));
export const fileSchema = z.object({ destination: relative, sha256: sha, mode: z.number().int().min(0).max(511),
  size: z.number().int().min(0).max(536870912) }).strict();
export const witnessSchema = z.object({
  schema: z.enum(["spawnfile.training-legacy-witness.v1", "spawnfile.training-witness.v1"]),
  parentImage: sha, parentPreparationDigest: sha, imagePlanDigest: sha,
  config: trainingPreparationSchema, context: trainingContextSchema,
  command: z.object({ args: z.array(z.string()), env: z.record(z.string(), z.string()).optional() }).strict(),
  inputs: z.array(z.object({ id: z.string(), source: z.string(), destination: z.string(), digest: sha,
    staged: z.string(), snapshotDigest: sha.nullable() }).strict()),
  repair: z.object({ witness: sha, parent: sha }).strict().optional(),
  image: z.object({ build: trainingBuildSchema, dockerfile: z.string(), entry: z.string(), brokerEntry: z.string(), files: z.array(fileSchema).min(1).max(10000) }).strict()
}).strict();
export type TrainingWitness = z.infer<typeof witnessSchema>;
export const witnessEnvelopeSchema = z.object({ manifest: witnessSchema, digest: sha }).strict();
export const repairReceiptSchema = z.object({
  version: z.literal("paideia.measurement-repair.v1"),
  parent: z.object({ root: z.literal("/run/training/inputs/repair-parent"), imageId: sha,
    experimentId: z.string().uuid(), executionIdentity: z.string().regex(/^[a-f0-9]{64}$/u), manifestDigest: sha,
    checkpoints: z.object({ command: sha, training: sha, host: sha, optimizer: sha }).strict(),
    trainingIdentity: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  current: z.object({ imageId: sha, canonicalSourceDigest: sha, adapterId: z.literal("daimon-native") }).strict(),
  compatibility: z.object({ version: z.literal("spawnfile.daimon-dspy-compatibility.v1"), digest: sha,
    components: z.record(z.string(), sha), inputs: z.record(z.string(), sha) }).strict()
}).strict();
export const repairEnvelopeSchema = z.object({ receipt: repairReceiptSchema, digest: sha }).strict();
export type RepairEnvelope = z.infer<typeof repairEnvelopeSchema>;
