import path from "node:path";
import { z } from "zod";

const hostPath = z.string().min(1).refine((value) => path.isAbsolute(value) && !/[,\r\n\0]/u.test(value), "Expected an absolute bind path");
const inputPath = z.string().regex(/^\/run\/training\/inputs\/[A-Za-z0-9._/-]+$/u).refine((value) => path.posix.normalize(value) === value && !value.endsWith("/"));
export const trainingImageSchema = z.string().regex(/^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64})$/u);
const brokerLaunchSchema = z.object({
  engine: z.literal("grok"),
  /** The named Docker volume holding the training Grok realm: `auth.json` and the broker credential journal, nothing else. */
  realmVolume: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  /** Host leaf of the dedicated training Grok login. Never the desktop `~/.grok/auth.json`. */
  bootstrap: hostPath,
  /** `spawnfile.training-broker.v1`, written beside the launch config and bound read-only into the container. */
  declaration: hostPath
}).strict();

export const trainingContainerConfigSchema = z.object({
  version: z.enum(["spawnfile.training-container.v1", "spawnfile.training-container.v3"]),
  dockerContext: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  inputs: z.array(z.object({ source: hostPath, destination: inputPath }).strict()).min(1).max(64),
  output: z.object({ source: hostPath, destination: z.literal("/run/training/output") }).strict(),
  auth: z.array(z.object({ source: hostPath, provider: z.enum(["codex", "claude"]) }).strict()).max(2),
  /** Present only on `spawnfile.training-container.v3`: the brokered Grok slot this container runs as root. */
  broker: brokerLaunchSchema.optional()
}).strict().superRefine((value, context) => {
  const destinations = value.inputs.map((entry) => entry.destination);
  if (destinations.some((entry, index) => destinations.some((other, otherIndex) => otherIndex !== index && (entry === other || entry.startsWith(`${other}/`))))) {
    context.addIssue({ code: "custom", message: "Input destinations must not overlap" });
  }
  if (new Set(value.auth.map((entry) => entry.provider)).size !== value.auth.length) context.addIssue({ code: "custom", message: "Duplicate auth provider" });
  if ((value.version === "spawnfile.training-container.v3") !== (value.broker !== undefined)) {
    context.addIssue({ code: "custom", message: "Only spawnfile.training-container.v3 declares a broker slot, and it always does" });
  }
});
export type TrainingContainerConfig = z.infer<typeof trainingContainerConfigSchema>;
