import { z } from "zod";

import { memoryBankSchema } from "./memorySchemas.js";
import { teamNetworkSchema } from "./teamNetworkSchemas.js";
import { trainingNameSchema, trainingRelativePathSchema } from "./trainingSchemas.js";
import { teamWorkspaceResourceSchema } from "./workspaceSchemas.js";

const uniqueIds = (entries: Array<{ id: string }>, context: z.RefinementCtx): void => {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (ids.has(entry.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id ${entry.id}`, path: [index, "id"] });
    }
    ids.add(entry.id);
  });
};

export const trainingInstantSchema = z.iso.datetime({ offset: true });

export const trainingWakeSchema = z.object({
  surface: z.literal("moltnet"),
  room: z.string(),
  from: z.string(),
  text: z.string()
}).strict();

const trainingExampleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/u),
  at: trainingInstantSchema,
  wake: trainingWakeSchema,
  memory: z.array(memoryBankSchema).optional(),
  resources: z.array(teamWorkspaceResourceSchema).optional(),
  networks: z.array(teamNetworkSchema).optional()
}).strict();

export const trainingDatasetSchema = z.object({
  examples: z.array(trainingExampleSchema).min(1).superRefine(uniqueIds)
}).strict();

const trainingAnswerSchema = z.union([z.string(), z.number(), z.boolean()]);

const trainingQuestionSchema = z.object({
  id: trainingNameSchema,
  ask: z.string(),
  expected: trainingAnswerSchema
}).strict();

const trainingLabelSchema = z.object({
  id: z.string().min(1),
  output: trainingRelativePathSchema,
  answers: z.record(trainingNameSchema, trainingAnswerSchema).refine(
    (answers) => Object.keys(answers).length > 0,
    { message: "label answers must not be empty" }
  )
}).strict();

export const trainingGraderSchema = z.object({
  questions: z.array(trainingQuestionSchema).min(1).superRefine(uniqueIds),
  labels: z.array(trainingLabelSchema).superRefine(uniqueIds).optional()
}).strict().superRefine((value, context) => {
  const questionIds = new Set(value.questions.map((question) => question.id));
  value.labels?.forEach((label, index) => {
    for (const id of Object.keys(label.answers)) {
      if (!questionIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `label ${label.id} answer references unknown question ${id}`,
          path: ["labels", index, "answers", id]
        });
      }
    }
  });
});

export type TrainingDataset = z.infer<typeof trainingDatasetSchema>;
export type TrainingGrader = z.infer<typeof trainingGraderSchema>;
