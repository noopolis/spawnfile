import path from "node:path";
import { z } from "zod";
import { trainingImageSchema } from "../container/contract.js";

const local = z.string().min(1).refine(value => !/[,\r\n\0]/u.test(value));
const relative = local.refine(value => !path.isAbsolute(value) && !value.includes("\\") && value.split("/").every(part => part !== "" && part !== "." && part !== ".." && part !== ".git"));
const reference = z.object({ input: z.string().min(1), path: z.union([z.literal("."), relative]) }).strict();
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const destination = z.string().regex(/^\/run\/training\/inputs\/[A-Za-z0-9._/-]+$/u).refine(value => path.posix.normalize(value) === value && !value.endsWith("/"));
export const trainingBuildSchema = z.object({
  recipe: z.literal("daimon-dspy.v1"), nativeImage: trainingImageSchema, pythonImage: trainingImageSchema,
  platform: z.enum(["linux/arm64", "linux/amd64"]),
  paideia: local, bridge: local, claude: local, compiler: local.optional(),
  grok: z.object({ source: local, sha256: sha }).strict(),
  integration: z.object({ source: local, entry: relative.refine(value => /^[A-Za-z0-9._/-]+$/u.test(value)) }).strict(), bootstrap: local.optional()
}).strict();
export const trainingPreparationSchema = z.object({
  version: z.literal("spawnfile.training-container.v2"),
  dockerContext: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  image: z.union([z.object({ ref: trainingImageSchema }).strict(), z.object({ build: trainingBuildSchema }).strict()]),
  integration: z.object({ settings: reference }).strict(),
  inputs: z.array(z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u), source: local, destination,
    include: z.array(relative).min(1).max(256).optional(),
    git: z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/u),
      overlays: z.array(z.object({ source: local, path: relative, sha256: sha }).strict()).max(256).default([])
    }).strict().optional()
  }).strict()).min(1).max(64),
  output: z.object({ source: local, destination: z.literal("/run/training/output") }).strict(),
  auth: z.array(z.object({ source: local, provider: z.enum(["codex", "grok", "claude"]) }).strict()).max(3)
}).strict().superRefine((value, context) => {
  if (new Set(value.inputs.map(input => input.id)).size !== value.inputs.length) context.addIssue({ code: "custom", message: "Input IDs must be unique" });
  if (new Set(value.auth.map(auth => auth.provider)).size !== value.auth.length) context.addIssue({ code: "custom", message: "Auth providers must be unique" });
  if (!value.inputs.some(input => input.id === value.integration.settings.input)) context.addIssue({ code: "custom", message: "Integration settings require a declared input" });
  if (value.inputs.some(input => input.git && input.include)) context.addIssue({ code: "custom", message: "Git snapshots and selective local inputs are separate modes" });
});
export type TrainingPreparationConfig = z.infer<typeof trainingPreparationSchema>;
export type TrainingImageBuild = z.infer<typeof trainingBuildSchema>;

/** Image integration reads this protected, container-addressed receipt, never host paths. */
export interface TrainingMappedPreparation {
  version: "spawnfile.training-preparation.v1";
  preparationDigest: string;
  imageId: string;
  bindings: { inputId: string; destination: string }[];
  outputRoot: "/run/training/output";
  packagePaths: { spawnfile: string; paideia: string; bridge: string; nativeWorker: string; integration: string; bootstrap: string };
  integration: { settings: { input: string; path: string } };
}

const containerPath = z.string().regex(/^\/(?:run|opt)\/[A-Za-z0-9._/-]+$/u).refine(value => path.posix.normalize(value) === value);
const mappedSchema = z.object({
  version: z.literal("spawnfile.training-preparation.v1"), preparationDigest: sha, imageId: trainingImageSchema,
  bindings: z.array(z.object({ inputId: z.string().min(1), destination }).strict()).min(1).max(64),
  outputRoot: z.literal("/run/training/output"),
  packagePaths: z.object({ spawnfile: containerPath, paideia: containerPath, bridge: containerPath,
    nativeWorker: containerPath, integration: containerPath, bootstrap: containerPath }).strict(),
  integration: z.object({ settings: reference }).strict()
}).strict().superRefine((value, context) => {
  if (new Set(value.bindings.map(binding => binding.inputId)).size !== value.bindings.length ||
    !value.bindings.some(binding => binding.inputId === value.integration.settings.input)) context.addIssue({ code: "custom", message: "Invalid preparation binding IDs" });
});
export const parseTrainingMappedPreparation = (value: unknown): TrainingMappedPreparation => mappedSchema.parse(value);
