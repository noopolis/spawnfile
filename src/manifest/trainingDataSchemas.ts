import { compatibleIsoDateTimeSchema } from '../shared/index.js';
import { z } from "zod";

import { memoryBankSchema } from "./memorySchemas.js";
import { teamNetworkSchema } from "./teamNetworkSchemas.js";
import { workspaceResourceVolumeObjectSchema } from "./workspaceSchemas.js";

const uniqueIds = (entries: Array<{ id: string }>, context: z.RefinementCtx): void => {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (ids.has(entry.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id ${entry.id}`, path: [index, "id"] });
    }
    ids.add(entry.id);
  });
};

export const trainingInstantSchema = compatibleIsoDateTimeSchema({ offset: true });

export const trainingWakeSchema = z.object({
  surface: z.literal("moltnet"),
  room: z.string(),
  from: z.string(),
  text: z.string()
}).strict();

const containedPath = z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("\\") &&
  !value.split("/").some((part) => part === "" || part === "." || part === ".."), "must be a contained relative path");
/** Relative to the dataset file; may climb to a sibling directory, but never leaves the project (checked at load). */
const datasetRelativePath = z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes("\\"), "must be a relative path");

/**
 * A moment's starting state: a fresh per-trial volume at the compiled resource's mount, filled before boot
 * from one source (a `feed`, inline `files`) or left empty.
 */
export const trainingMomentResourceSchema = workspaceResourceVolumeObjectSchema.extend({
  files: z.record(containedPath, z.string()).optional()
}).strict().superRefine((value, context) => {
  if (value.feed && value.files) context.addIssue({ code: z.ZodIssueCode.custom, message: "a moment resource declares at most one of feed or files" });
  const feed = value.feed;
  if (!feed) return;
  for (const field of ["include", "prepare", "validate", "freeze"] as const) {
    if (feed[field] !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: `a moment feed is one fixed source; ${field} is not supported` });
  }
  if (feed.git && typeof feed.git.ref !== "string") context.addIssue({ code: z.ZodIssueCode.custom, message: "a moment git feed names one fixed ref" });
  if (feed.git?.paths?.some((entry) => entry.includes("${"))) context.addIssue({ code: z.ZodIssueCode.custom, message: "a moment git feed path is a plain path" });
});

const trainingExampleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/u),
  at: trainingInstantSchema,
  wake: trainingWakeSchema,
  memory: z.array(memoryBankSchema).optional(),
  resources: z.array(trainingMomentResourceSchema).superRefine(uniqueIds).optional(),
  networks: z.array(teamNetworkSchema).optional(),
  /** This case's grader, relative to the dataset file; the target's grader otherwise. */
  grader: datasetRelativePath.optional(),
  /** Grader context bound from files relative to the dataset file. */
  context: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/u), z.object({ file: datasetRelativePath }).strict()).optional(),
  /** Workspace-relative file the trial leaves as its output; the final reply otherwise. */
  output: containedPath.optional()
}).strict();

/**
 * A step production runs inside the started organization before it takes work (an operator's
 * `docker exec`, such as materializing a token file from the container's own environment).
 * Every moment of the dataset reproduces it after boot, before the wake.
 */
export const trainingAfterBootStepSchema = z.object({
  user: z.string().regex(/^\d+:\d+$/u, "user must be <uid>:<gid>"),
  command: z.array(z.string().min(1)).min(1),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()).optional()
}).strict();

export const trainingDatasetSchema = z.object({
  after_boot: z.array(trainingAfterBootStepSchema).optional(),
  examples: z.array(trainingExampleSchema).min(1).superRefine(uniqueIds)
}).strict();

export type TrainingDataset = z.infer<typeof trainingDatasetSchema>;
export type TrainingMomentResource = z.infer<typeof trainingMomentResourceSchema>;
