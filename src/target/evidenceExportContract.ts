import { Buffer } from "node:buffer";

import { z } from "zod";

export const TARGET_EXPORT_INDEX_VERSION = "spawnfile.target-resource.export-index.v1" as const;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const handle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);
const label = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  value: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)
}).strict();
const activationMarker = ".spawnfile/world-service-activated.v1";
const path = z.string().max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .or(z.literal(activationMarker))
  .refine((value) => !value.includes("//")
    && !value.split("/").some((part) => part === "." || part === ".."));
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 128);

export const targetResourceExportIndexSchema = z.object({
  evidence_digest: digest,
  export_handle: handle,
  files: z.array(z.object({
    bytes: z.number().int().min(0).max(67_108_864), path, sha256: digest
  }).strict()).max(10_000),
  item_count: z.number().int().min(0).max(10_000),
  labels: z.array(label).max(16),
  run_id: runId,
  source: z.object({ evidence_volume_handle: handle, state: z.literal("preserved") }).strict(),
  state: z.enum(["exported", "incomplete"]),
  version: z.literal(TARGET_EXPORT_INDEX_VERSION)
}).strict().superRefine((value, context) => {
  const paths = value.files.map((file) => file.path);
  if (value.item_count !== value.files.length) context.addIssue({
    code: z.ZodIssueCode.custom, message: "evidence export item count is invalid"
  });
  if (new Set(paths).size !== paths.length
    || paths.some((entry, index) => index > 0 && paths[index - 1]! >= entry)) context.addIssue({
    code: z.ZodIssueCode.custom, message: "evidence export file inventory is invalid"
  });
});

export type TargetResourceExportIndex = z.infer<typeof targetResourceExportIndexSchema>;
