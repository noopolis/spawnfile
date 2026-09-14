import path from "node:path";
import { z } from "zod";

const hostPath = z.string().min(1).refine((value) => path.isAbsolute(value) && !/[,\r\n\0]/u.test(value), "Expected an absolute bind path");
const inputPath = z.string().regex(/^\/run\/training\/inputs\/[A-Za-z0-9._/-]+$/u).refine((value) => path.posix.normalize(value) === value && !value.endsWith("/"));
export const trainingImageSchema = z.string().regex(/^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64})$/u);
export const trainingContainerConfigSchema = z.object({
  version: z.literal("spawnfile.training-container.v1"),
  dockerContext: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  inputs: z.array(z.object({ source: hostPath, destination: inputPath }).strict()).min(1).max(64),
  output: z.object({ source: hostPath, destination: z.literal("/run/training/output") }).strict(),
  auth: z.array(z.object({ source: hostPath, provider: z.enum(["codex", "grok", "claude"]) }).strict()).max(3)
}).strict().superRefine((value, context) => {
  const destinations = value.inputs.map((entry) => entry.destination);
  if (destinations.some((entry, index) => destinations.some((other, otherIndex) => otherIndex !== index && (entry === other || entry.startsWith(`${other}/`))))) {
    context.addIssue({ code: "custom", message: "Input destinations must not overlap" });
  }
  if (new Set(value.auth.map((entry) => entry.provider)).size !== value.auth.length) context.addIssue({ code: "custom", message: "Duplicate auth provider" });
});
export type TrainingContainerConfig = z.infer<typeof trainingContainerConfigSchema>;
