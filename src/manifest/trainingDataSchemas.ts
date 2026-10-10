import { z } from "zod";

import { memoryBankSchema } from "./memorySchemas.js";
import { teamNetworkSchema } from "./teamNetworkSchemas.js";
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

export type TrainingDataset = z.infer<typeof trainingDatasetSchema>;
