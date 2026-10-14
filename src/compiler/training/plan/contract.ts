import { z } from "zod";

import { trainingInstantSchema, trainingWakeSchema } from "../../../manifest/index.js";

export const TRAINING_PLAN_VERSION = "spawnfile.training-plan.v1" as const;

const text = z.string().min(1);
const absolutePath = text.regex(/^(?:\/|[A-Za-z]:[\\/])/u);
const relativePath = text.regex(/^(?!\/)[^\\]+$/u);
const source = z.object({ sourcePath: absolutePath, path: relativePath }).strict();
export const trainingAssetsSchema = z.object({
  root: absolutePath,
  files: z.array(source.extend({ sha256: text.regex(/^sha256:[a-f0-9]{64}$/u) }).strict()).min(1)
}).strict();
const reference = z.object({ id: text, declaredBy: text }).strict();

export const trainingPlanDatasetSchema = source.extend({
  examples: z.array(z.object({
    id: text.regex(/^[A-Za-z0-9._-]+$/u),
    at: trainingInstantSchema,
    wake: trainingWakeSchema,
    overrides: z.array(reference.extend({ section: z.enum(["resources", "memory", "networks"]) }).strict())
  }).strict()).min(1)
}).strict();

export const trainingPlanOptimizerSchema = z.object({
  method: text, model: text, variants: z.number().int().min(1), keep: z.number().int().min(1),
  budget: z.object({ rounds: z.number().int().min(1) }).strict()
}).strict();

export const trainingPlanSchema = z.object({
  version: z.literal(TRAINING_PLAN_VERSION),
  producer: z.object({ package: z.literal("spawnfile"), version: text }).strict(),
  project: z.object({ root: absolutePath, manifest: absolutePath }).strict(),
  agent: z.object({ id: text, name: text }).strict(),
  assets: trainingAssetsSchema.optional(),
  preparation: z.object({ hook: text, history: absolutePath.optional() }).strict().optional(),
  record: z.object({
    keep: text.regex(/^[1-9][0-9]*[mhd]$/u).nullable(),
    volumes: z.array(reference)
  }).strict().nullable(),
  optimizer: trainingPlanOptimizerSchema.nullable(),
  graders: z.array(source.extend({
    name: text.regex(/^[A-Za-z0-9_-]+$/u), declaredBy: text
  }).strict()),
  targets: z.array(z.object({
    declaredBy: text, grader: text.regex(/^[A-Za-z0-9_-]+$/u),
    files: z.array(source.extend({ consumers: z.array(text).min(1) }).strict()).min(1),
    datasets: z.object({
      train: trainingPlanDatasetSchema,
      validation: trainingPlanDatasetSchema.nullable(),
      test: trainingPlanDatasetSchema
    }).strict()
  }).strict())
}).strict();

export type TrainingPlan = z.infer<typeof trainingPlanSchema>;
export type TrainingPlanDataset = z.infer<typeof trainingPlanDatasetSchema>;
export type TrainingPlanOverride = TrainingPlanDataset["examples"][number]["overrides"][number];
export const trainingPlanJsonSchema = z.toJSONSchema(trainingPlanSchema);
