import path from "node:path";
import { z } from "zod";
import { trainingImageSchema } from "../container/contract.js";
import { DAIMON_GROK_BROKER_MODELS, DAIMON_GROK_BROKER_REASONING_EFFORTS, DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";

const local = z.string().min(1).refine(value => !/[,\r\n\0]/u.test(value));
const relative = local.refine(value => !path.isAbsolute(value) && !value.includes("\\") && value.split("/").every(part => part !== "" && part !== "." && part !== ".." && part !== ".git"));
const reference = z.object({ input: z.string().min(1), path: z.union([z.literal("."), relative]) }).strict();
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const destination = z.string().regex(/^\/run\/training\/inputs\/[A-Za-z0-9._/-]+$/u).refine(value => path.posix.normalize(value) === value && !value.endsWith("/"));
export const trainingBuildSchema = z.object({
  recipe: z.literal("daimon-dspy.v1"), nativeImage: trainingImageSchema, pythonImage: trainingImageSchema,
  platform: z.enum(["linux/arm64", "linux/amd64"]),
  paideia: local, bridge: local, claude: local, compiler: local.optional(),
  /**
   * Deprecated with `spawnfile.training-container.v3`: the image no longer
   * copies a Grok binary at all. Judges run the native parent's pinned
   * `/usr/local/bin/grok` through a broker inference grant, so a second copy
   * could only ever be a different, unattested build.
   */
  grok: z.object({ source: local, sha256: sha }).strict().optional(),
  integration: z.object({ source: local, entry: relative.refine(value => /^[A-Za-z0-9._/-]+$/u.test(value)) }).strict(), bootstrap: local.optional()
}).strict();
const bounds = DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds;
/**
 * `spawnfile.training-container.v3`'s brokered Grok slot.
 *
 * It is the whole difference from v2: the container starts as root with the
 * production capability set, runs one broker slot for the subject, holds the
 * dedicated training Grok login in a named realm volume seeded from
 * `bootstrap`, and serves judge inference grants out of the same credential.
 * No Grok binary and no Grok auth staging enter the image.
 */
export const trainingBrokerSchema = z.object({
  engine: z.literal("grok"),
  agentId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  model: z.enum(DAIMON_GROK_BROKER_MODELS),
  reasoningEffort: z.enum(DAIMON_GROK_BROKER_REASONING_EFFORTS),
  architecture: z.enum(["arm64", "x64"]),
  limits: z.object({
    maxRequests: z.number().int().min(bounds.maxRequests[0]).max(bounds.maxRequests[1]),
    maxTokens: z.number().int().min(bounds.maxTokens[0]).max(bounds.maxTokens[1]),
    timeoutMs: z.number().int().min(bounds.timeoutMs[0]).max(bounds.timeoutMs[1])
  }).strict(),
  /** Named Docker volume for the rotating training credential and its journal; never a host bind. */
  realmVolume: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  /** The dedicated training Grok login leaf, relative to the declaration. Never the desktop `~/.grok/auth.json`. */
  bootstrap: local,
  unenforcedBindPolicy: z.enum(["refuse", "profile-only"]).optional()
}).strict();

export const trainingPreparationSchema = z.object({
  version: z.enum(["spawnfile.training-container.v2", "spawnfile.training-container.v3"]),
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
  auth: z.array(z.object({ source: local, provider: z.enum(["codex", "claude"]) }).strict()).max(2),
  broker: trainingBrokerSchema.optional()
}).strict().superRefine((value, context) => {
  if ((value.version === "spawnfile.training-container.v3") !== (value.broker !== undefined)) {
    context.addIssue({ code: "custom", message: "Only spawnfile.training-container.v3 declares a broker slot, and it always does" });
  }
  if (value.broker && "build" in value.image && value.image.build.grok) {
    context.addIssue({ code: "custom", message: "A v3 training image never copies a Grok binary; judges use the native parent's pinned /usr/local/bin/grok" });
  }
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
