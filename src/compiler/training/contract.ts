import { z } from "zod";

export const TRAINING_CONTEXT_VERSION = "spawnfile.training-context.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const absolutePath = z.string().min(1).regex(/^(?:\/|[A-Za-z]:[\\/])/u);
const relativePath = z.string().min(1).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/u);
const text = z.string().min(1);

export const trainingSourceSchema = z.object({
  sourcePath: absolutePath,
  destinationPath: relativePath,
  sha256: digest
}).strict();

/** Trusted compiler metadata only; this is neither a prompt nor permission to launch. */
export const trainingContextSchema = z.object({
  version: z.literal(TRAINING_CONTEXT_VERSION),
  producer: z.object({ package: z.literal("spawnfile"), version: text }).strict(),
  project: z.object({ root: absolutePath, manifest: absolutePath, sourceDigest: digest }).strict(),
  agent: z.object({
    id: text, name: text, source: absolutePath, runtime: text,
    engine: text.nullable(),
    model: z.object({ provider: text, name: text, authMethod: text }).strict().nullable()
  }).strict(),
  sources: z.array(trainingSourceSchema).min(1).max(10_000),
  documents: z.array(trainingSourceSchema.extend({ role: text }).strict()).max(128),
  skills: z.array(trainingSourceSchema.extend({
    name: text, ref: text, requiresMcp: z.array(text)
  }).strict()).max(1_000),
  resources: z.array(z.object({
    id: text, kind: z.enum(["bundle", "git", "volume"]), mount: text,
    mode: z.enum(["mutable", "readonly"]), sharing: z.enum(["per_agent", "team"]),
    definitionDigest: digest, pin: text.nullable()
  }).strict()).max(1_000),
  requirements: z.object({ nativeCompilation: z.literal(true), isolatedPreparation: z.literal(true) }).strict()
}).strict();

export type TrainingContext = z.infer<typeof trainingContextSchema>;
export type TrainingSource = z.infer<typeof trainingSourceSchema>;

export const trainingContextJsonSchema = z.toJSONSchema(trainingContextSchema);
