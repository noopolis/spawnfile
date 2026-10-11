import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { appendRetainedJsonl, entryAt, readRetainedJsonl } from "../filesystem/index.js";
import type { RecordingReport } from "../report/index.js";

export const DEPLOY_RESOURCES_VERSION = "spawnfile.deploy-resources.v1";
export const DEPLOY_RESOURCE_LOG_FILE = "resource-log.jsonl";
const text = z.string().min(1);
const digest = text.regex(/^sha256:[a-f0-9]{64}$/u);
const ownership = { agent_node_ids: z.array(text).min(1), declared_by: text.optional() };
const resourceSchema = z.discriminatedUnion("kind", [
  z.object({ ...ownership, id: text, kind: z.literal("git"), commit: text.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u), sha256: digest, url: text.optional() }).strict(),
  z.object({ ...ownership, id: text, kind: z.literal("bundle"), sha256: digest, origin: text.optional() }).strict()
]);
export const deployResourcesSchema = z.object({
  version: z.literal(DEPLOY_RESOURCES_VERSION), deployment: text,
  deployment_id: text,
  activated_at: z.iso.datetime({ offset: true }), activation_exact: z.boolean(), activation_note: text.optional(),
  deployed_at: z.iso.datetime({ offset: true }), report_sha256: digest,
  resources: z.array(resourceSchema)
}).strict();
export type DeployResources = z.infer<typeof deployResourcesSchema>;

export interface ResourceOwnership { agent_node_ids: string[]; declared_by?: string }
/** Both reports carry the already-resolved pins; distribution omits private URLs. */
export interface DeployResourceReport {
  recording?: RecordingReport;
  workspace_git_resources?: Array<ResourceOwnership & { id: string; commit: string; sha256: string; url?: string }>;
  workspace_bundles?: Array<ResourceOwnership & { id: string; sha256: string; origin?: string }>;
}
export interface DeploymentActivation {
  activated_at?: string;
  activation_exact?: boolean;
  activation_note?: string;
}
const isDeployResources = (value: unknown): value is DeployResources => deployResourcesSchema.safeParse(value).success;

/** Record path is the deployment identity: project output scoped, or home scoped. */
export const deployResourceLogPath = (recordPath: string): string => path.join(path.dirname(recordPath),
  path.basename(recordPath) === "record.json" ? DEPLOY_RESOURCE_LOG_FILE : `${path.basename(recordPath, ".json")}.${DEPLOY_RESOURCE_LOG_FILE}`);

export const createDeployResources = (
  recordPath: string, record: DeploymentActivation & { name: string; created_at: string },
  report: DeployResourceReport, reportBytes: string
): DeployResources => deployResourcesSchema.parse({
  version: DEPLOY_RESOURCES_VERSION, deployment: record.name, deployment_id: path.resolve(recordPath),
  deployed_at: record.created_at, activated_at: record.activated_at ?? record.created_at,
  activation_exact: record.activation_exact ?? false,
  ...((record.activation_note || !record.activated_at) ? { activation_note: record.activation_note ?? "Activation boundary was not recorded" } : {}),
  report_sha256: `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`,
  resources: [
    ...(report.workspace_git_resources ?? []).map(({ id, commit, sha256, url, agent_node_ids, declared_by }) =>
      ({ id, kind: "git", commit, sha256, agent_node_ids, ...(declared_by ? { declared_by } : {}), ...(url === undefined ? {} : { url }) })),
    ...(report.workspace_bundles ?? []).map(({ id, sha256, origin, agent_node_ids, declared_by }) =>
      ({ id, kind: "bundle", sha256, agent_node_ids, ...(declared_by ? { declared_by } : {}), ...(origin === undefined ? {} : { origin }) }))
  ]
});

/** Invalid/legacy unowned lines are reported; never guess an agent's pin. */
export const readDeployResources = (recordPath: string) =>
  readRetainedJsonl(deployResourceLogPath(recordPath), isDeployResources);

export const deployResourcesAt = (
  entries: readonly DeployResources[], recordPath: string, instant: string | Date, agentNodeId?: string
): DeployResources | null => {
  const entry = entryAt(entries.filter((value) => value.deployment_id === path.resolve(recordPath)), instant, (value) => value.activated_at);
  return entry && agentNodeId !== undefined
    ? { ...entry, resources: entry.resources.filter((resource) => resource.agent_node_ids.includes(agentNodeId)) }
    : entry;
};

/** Caller holds the publication lock. Reconcile only against the LAST entry. */
export const ensureDeployResources = (recordPath: string, entry: DeployResources, keepMs: number): void => {
  if (entry.deployment_id !== path.resolve(recordPath)) throw new Error("Deployment history identity does not match its record path");
  const history = readDeployResources(recordPath);
  if (history.errors.length) throw new Error(`Cannot reconcile deployment history: ${history.errors.join("; ")}`);
  if (JSON.stringify(history.entries.at(-1)) === JSON.stringify(entry)) return;
  appendRetainedJsonl(deployResourceLogPath(recordPath), entry, {
    keepMs, now: new Date(), timeOf: (value) => value.activated_at, isEntry: isDeployResources
  });
};
