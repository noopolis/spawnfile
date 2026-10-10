import { posix, win32 } from "node:path";
import { z } from "zod";

export const trainingNameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const trainingRelativePathSchema = z.string().min(1).refine(
  (value) => !posix.isAbsolute(value) && !win32.isAbsolute(value) && !value.includes("\\"),
  { message: "training paths must be relative to the declaring file and use forward slashes" }
);

const uniqueStrings = (schema: z.ZodString, message: string) => z.array(schema).refine(
  (values) => new Set(values).size === values.length,
  { message }
);

const trainingRecordSchema = z.object({
  keep: z.string().regex(/^[1-9][0-9]*[mhd]$/u, "keep must be a positive duration in m, h, or d").optional(),
  volumes: uniqueStrings(z.string().min(1), "record volume ids must be unique").optional()
}).strict();

const trainingOptimizerSchema = z.object({
  method: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  variants: z.number().int().min(1).optional(),
  keep: z.number().int().min(1).optional(),
  budget: z.object({ rounds: z.number().int().min(1).optional() }).strict().optional()
}).strict();

export const trainingTargetSchema = z.object({
  files: uniqueStrings(
    trainingRelativePathSchema.endsWith(".md", "training target files must end in .md"),
    "training target files must be unique"
  ).min(1),
  grader: trainingNameSchema,
  datasets: z.object({
    train: trainingRelativePathSchema,
    validation: trainingRelativePathSchema.optional(),
    test: trainingRelativePathSchema
  }).strict()
}).strict();

export const trainingDeclarationSchema = z.object({
  record: trainingRecordSchema.optional(),
  optimizer: trainingOptimizerSchema.optional(),
  graders: z.record(trainingNameSchema, trainingRelativePathSchema).optional(),
  targets: z.array(trainingTargetSchema).optional()
}).strict();

export type TrainingDeclaration = z.infer<typeof trainingDeclarationSchema>;
export type TrainingTarget = z.infer<typeof trainingTargetSchema>;
