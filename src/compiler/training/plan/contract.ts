import { z } from "zod";

import { trainingInstantSchema, trainingWakeSchema } from "../../../manifest/index.js";

export const TRAINING_PLAN_VERSION = "spawnfile.training-plan.v1" as const;

const text = z.string().min(1);
const absolutePath = text.regex(/^(?:\/|[A-Za-z]:[\\/])/u);
const relativePath = text.regex(/^(?!\/)[^\\]+$/u);
const source = z.object({ sourcePath: absolutePath, path: relativePath }).strict();
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
  method: text, model: text, provider: text.optional(), variants: z.number().int().min(1), keep: z.number().int().min(1),
  budget: z.object({ rounds: z.number().int().min(1) }).strict(),
  boundaries: z.array(text).max(50).optional()
}).strict();

export const trainingPlanJudgeSchema = z.object({ provider: text, model: text, effort: z.enum(["low", "medium", "high", "xhigh"]).optional() }).strict();
export const trainingPlanCriticSchema = z.object({
  judge: text.regex(/^[A-Za-z0-9_-]+$/u), guide: z.array(absolutePath).min(1),
  show: z.array(z.enum(["checks", "train-tasks"])), block_on: z.enum(["low", "medium", "high"])
}).strict();

export const trainingPlanSchema = z.object({
  version: z.literal(TRAINING_PLAN_VERSION),
  producer: z.object({ package: z.literal("spawnfile"), version: text }).strict(),
  project: z.object({ root: absolutePath, manifest: absolutePath }).strict(),
  agent: z.object({ id: text, name: text }).strict(),
  deadlines: z.object({
    experiment_ms: z.number().int().min(1).max(604_800_000),
    trial_ms: z.number().int().min(1).max(86_400_000).optional()
  }).strict().optional(),
  preparation: z.object({ hook: text, history: absolutePath.optional() }).strict().optional(),
  record: z.object({
    keep: text.regex(/^[1-9][0-9]*[mhd]$/u).nullable(),
    volumes: z.array(reference)
  }).strict().nullable(),
  optimizer: trainingPlanOptimizerSchema.nullable(),
  /** Named judge routes; absent when the agent declares none. */
  judges: z.record(text.regex(/^[A-Za-z0-9_-]+$/u), trainingPlanJudgeSchema).optional(),
  critic: trainingPlanCriticSchema.optional(),
  /** Repeated subject trials per validation case and per sealed test case. */
  budget: z.object({ validation_repeats: z.number().int().min(1).max(8).optional(), test_repeats: z.number().int().min(1).max(8).optional() }).strict().optional(),
  selection: z.object({ max_gap: z.number().min(0).max(1).optional(), max_gate_failure_rise: z.number().min(0).max(1).optional() }).strict().optional(),
  /** Search scoring of a trial that fails a gate; absent keeps the strict zero. */
  scoring: z.object({ search: z.enum(["gate", "ladder"]), gate_penalty: z.number().min(0).lt(1).optional(), missing_output: z.number().min(0).lt(1).optional() }).strict().optional(),
  /** Calibration sets judged before any trial. */
  calibration: z.array(absolutePath).min(1).optional(),
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
