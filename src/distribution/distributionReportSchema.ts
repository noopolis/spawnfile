import { z } from "zod";

import { SpawnfileError } from "../shared/index.js";

import { DISTRIBUTION_REPORT_VERSION } from "./types.js";
import type { DistributionReport } from "./types.js";

const secretEntrySchema = z.object({
  generated: z.boolean(),
  name: z.string().min(1),
  required: z.boolean()
}).strict();

// Path fields from an untrusted image flow into `docker run -v` mount specs. A
// crafted value containing `:` would inject extra mount fields (e.g. drop `:ro`
// or add options), and `..` could redirect the mount target. Constrain every
// path the consumer interpolates to a clean absolute POSIX path so a hostile
// report is rejected up front; a legitimately compiled image always satisfies this.
const containerPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.includes(":") &&
      !/\s/.test(value) &&
      !value.split("/").includes(".."),
    { message: "must be a clean absolute POSIX path (no ':', whitespace, or '..' segment)" }
  );

// Ports are interpolated into `-p host:container`; bound them to the valid TCP range.
const portSchema = z.number().int().min(1).max(65535);

const runtimeInstanceSchema = z.object({
  config_path: containerPathSchema,
  home_path: containerPathSchema.nullable(),
  id: z.string().min(1),
  internal_port: portSchema.nullable(),
  model_auth_methods: z.record(z.string(), z.string()),
  model_secrets_required: z.array(z.string()),
  node_ids: z.array(z.string()),
  published_port: portSchema.nullable(),
  runtime: z.string().min(1),
  workspace_path: containerPathSchema
}).strict();

export const distributionReportSchema = z.object({
  compile_fingerprint: z.string().min(1),
  generated_at: z.string().min(1),
  internal_ports: z.array(portSchema),
  model_auth_methods: z.record(z.string(), z.string()),
  moltnet: z.object({
    networks: z.array(z.object({
      binding: z.literal("env").optional(),
      id: z.string().min(1),
      server_mode: z.union([z.literal("external"), z.literal("managed")])
    }).strict())
  }).strict(),
  organization: z.object({
    agents: z.array(z.object({
      id: z.string().min(1),
      name: z.string(),
      runtime: z.string().nullable(),
      teams: z.array(z.string())
    }).strict()),
    project: z.string().min(1),
    teams: z.array(z.object({
      agents: z.array(z.string()),
      id: z.string().min(1),
      name: z.string()
    }).strict())
  }).strict(),
  persistent_mounts: z.array(z.object({
    durability: z.literal("persistent"),
    id: z.string().min(1),
    kind: z.literal("volume"),
    target: containerPathSchema
  }).strict()),
  port_mappings: z.array(z.object({
    internal_port: portSchema,
    published_port: portSchema
  }).strict()),
  ports: z.array(portSchema),
  resources: z.array(z.object({
    id: z.string().min(1),
    kind: z.union([z.literal("git"), z.literal("volume")]),
    link_path: z.string(),
    mode: z.union([z.literal("mutable"), z.literal("readonly")]),
    mount: z.string(),
    sharing: z.union([z.literal("per_agent"), z.literal("team")])
  }).strict()),
  runtime_instances: z.array(runtimeInstanceSchema),
  secrets: z.object({
    model: z.array(secretEntrySchema),
    project: z.array(secretEntrySchema),
    runtime: z.array(secretEntrySchema),
    surface: z.array(secretEntrySchema)
  }).strict(),
  version: z.literal(DISTRIBUTION_REPORT_VERSION)
}).strict();

export const parseDistributionReport = (
  source: unknown,
  sourceLabel = "distribution report"
): DistributionReport => {
  const parsed = distributionReportSchema.safeParse(source);
  if (!parsed.success) {
    throw new SpawnfileError(
      "validation_error",
      `Invalid ${sourceLabel}: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data as DistributionReport;
};
