import { posix, win32 } from "node:path";
import { z } from "zod";

export const trainingNameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

/** Zod records skip __proto__ before validating keys, so inspect the authored map first. */
export const trainingNamedMapSchema = <T extends z.ZodType>(valueSchema: T) => z.unknown().superRefine(
  (value, context) => {
    if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
      context.addIssue({
        code: z.ZodIssueCode.custom, path: ["__proto__"], message: "training map key __proto__ is reserved"
      });
    }
  }
).pipe(z.record(trainingNameSchema, valueSchema));

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
  /** The inference provider that serves `model` (a training provider id, e.g. a subscription); the core default otherwise. */
  provider: z.string().min(1).optional(),
  variants: z.number().int().min(1).optional(),
  keep: z.number().int().min(1).optional(),
  budget: z.object({ rounds: z.number().int().min(1).optional() }).strict().optional(),
  /** Hard proposal constraints (preserve, require-text, forbid-text, max-bytes), each naming an editable target file. */
  boundaries: z.array(z.string().min(1).max(500)).max(50).optional()
}).strict();

/** A named judge route: the strong model that answers questionnaire groups and reviews candidate prompts. */
const trainingJudgeSchema = z.object({
  /** A training inference provider id (a subscription). */
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional()
}).strict();

/** The prompt critic gate: a candidate prompt must pass this review before it can be selected. */
const trainingCriticSchema = z.object({
  judge: trainingNameSchema,
  /** House documents the candidate is reviewed against, relative to the declaring file. */
  guide: uniqueStrings(trainingRelativePathSchema, "critic guide documents must be unique").min(1),
  show: z.array(z.enum(["checks", "train-tasks"])).refine((values) => new Set(values).size === values.length, { message: "critic show entries must be unique" }).optional(),
  block_on: z.enum(["low", "medium", "high"]).optional()
}).strict();

/** Repeated subject trials: trial noise dwarfs judge noise, so a case is run again, never judged again. */
const trainingBudgetSchema = z.object({
  /** Fresh trials per validation case and candidate; the search receives their mean. */
  validation_repeats: z.number().int().min(1).max(8).optional(),
  /** Fresh sealed trials per test case and arm. */
  test_repeats: z.number().int().min(1).max(8).optional()
}).strict();

/** Candidate rejection on what the optimizer could not see, measured over validation trials. */
const trainingSelectionSchema = z.object({
  /** Reject a candidate whose open minus hidden questionnaire gap exceeds the baseline's by more than this. */
  max_gap: z.number().min(0).max(1).optional(),
  /** Reject a candidate whose questionnaire gate failure rate exceeds the baseline's by more than this. */
  max_gate_failure_rise: z.number().min(0).max(1).optional()
}).strict().refine((value) => value.max_gap !== undefined || value.max_gate_failure_rise !== undefined,
  { message: "selection declares max_gap or max_gate_failure_rise" });

/** How a trial that fails a gate scores in the search. Acceptance (every gate passes) stays strict. */
const trainingScoringSchema = z.object({
  /** `gate` (default): a failed gate scores 0. `ladder`: each failed gate multiplies the score by its factor. */
  search: z.enum(["gate", "ladder"]),
  /** Factor of a failed gate check that declares no ladder of its own (default 0.5). */
  gate_penalty: z.number().min(0).lt(1).optional(),
  /** Search score of a trial that filed nothing (default 0.05). */
  missing_output: z.number().min(0).lt(1).optional()
}).strict().refine((value) => value.search === "ladder" || (value.gate_penalty === undefined && value.missing_output === undefined),
  { message: "gate_penalty and missing_output require search: ladder" });

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
  deadlines: z.object({
    experiment_ms: z.number().int().min(1).max(604_800_000).optional(),
    trial_ms: z.number().int().min(1).max(86_400_000).optional()
  }).strict().optional(),
  preparation: z.object({ hook: z.string().min(1), history: trainingRelativePathSchema.optional() }).strict().optional(),
  record: trainingRecordSchema.optional(),
  optimizer: trainingOptimizerSchema.optional(),
  judges: trainingNamedMapSchema(trainingJudgeSchema).optional(),
  critic: trainingCriticSchema.optional(),
  budget: trainingBudgetSchema.optional(),
  selection: trainingSelectionSchema.optional(),
  scoring: trainingScoringSchema.optional(),
  /** Calibration sets, relative to the declaring file: judged before any trial; a miss refuses the run. */
  calibration: uniqueStrings(trainingRelativePathSchema, "calibration sets must be unique").min(1).optional(),
  graders: trainingNamedMapSchema(trainingRelativePathSchema).optional(),
  targets: z.array(trainingTargetSchema).optional()
}).strict();

export type TrainingDeclaration = z.infer<typeof trainingDeclarationSchema>;
export type TrainingTarget = z.infer<typeof trainingTargetSchema>;
