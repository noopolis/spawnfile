import { z } from "zod";

import { SpawnfileError } from "../shared/index.js";

import { DISTRIBUTION_REPORT_VERSION } from "./types.js";
import type { DistributionReport } from "./types.js";

const secretEntrySchema = z.object({
  generated: z.boolean(),
  name: z.string().min(1),
  required: z.boolean()
}).strict();

const runtimeInstanceSchema = z.object({
  config_path: z.string(),
  home_path: z.string().nullable(),
  id: z.string().min(1),
  internal_port: z.number().nullable(),
  model_auth_methods: z.record(z.string(), z.string()),
  model_secrets_required: z.array(z.string()),
  node_ids: z.array(z.string()),
  published_port: z.number().nullable(),
  runtime: z.string().min(1),
  workspace_path: z.string()
}).strict();

export const distributionReportSchema = z.object({
  compile_fingerprint: z.string().min(1),
  generated_at: z.string().min(1),
  internal_ports: z.array(z.number()),
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
    target: z.string().min(1)
  }).strict()),
  port_mappings: z.array(z.object({
    internal_port: z.number(),
    published_port: z.number()
  }).strict()),
  ports: z.array(z.number()),
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
