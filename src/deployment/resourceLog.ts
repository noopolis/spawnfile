import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { appendRetainedJsonl, entryAt, readRetainedJsonl } from "../filesystem/index.js";
import type { RecordingReport } from "../report/index.js";

import { acquirePidLock } from "./pidLock.js";

export const DEPLOY_RESOURCES_VERSION = "spawnfile.deploy-resources.v1";
export const DEPLOY_RESOURCE_LOG_FILE = "resource-log.jsonl";

const text = z.string().min(1);
const digest = text.regex(/^sha256:[a-f0-9]{64}$/u);
const resourceSchema = z.discriminatedUnion("kind", [
  z.object({ id: text, kind: z.literal("git"), commit: text.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u), sha256: digest, url: text.optional() }).strict(),
  z.object({ id: text, kind: z.literal("bundle"), sha256: digest, origin: text.optional() }).strict()
]);
const entrySchema = z.object({
  version: z.literal(DEPLOY_RESOURCES_VERSION), deployment: text,
  deployed_at: z.iso.datetime({ offset: true }), report_sha256: digest,
  resources: z.array(resourceSchema)
}).strict();
export type DeployResources = z.infer<typeof entrySchema>;

/** Both reports carry the already-resolved pins; distribution omits private URLs. */
export interface DeployResourceReport {
  recording?: RecordingReport;
  workspace_git_resources?: Array<{ id: string; commit: string; sha256: string; url?: string }>;
  workspace_bundles?: Array<{ id: string; sha256: string; origin?: string }>;
}

const isDeployResources = (value: unknown): value is DeployResources => entrySchema.safeParse(value).success;

/** IDs in both report arrays are already the declaration IDs visible in agent workspaces. */
export const createDeployResources = (
  record: { name: string; created_at: string }, report: DeployResourceReport, reportBytes: string
): DeployResources => entrySchema.parse({
  version: DEPLOY_RESOURCES_VERSION, deployment: record.name, deployed_at: record.created_at,
  report_sha256: `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`,
  resources: [
    ...(report.workspace_git_resources ?? []).map(({ id, commit, sha256, url }) =>
      ({ id, kind: "git", commit, sha256, ...(url === undefined ? {} : { url }) })),
    ...(report.workspace_bundles ?? []).map(({ id, sha256, origin }) =>
      ({ id, kind: "bundle", sha256, ...(origin === undefined ? {} : { origin }) }))
  ]
});

/** Missing history is empty; invalid lines are reported alongside valid entries. */
export const readDeployResources = (stateDir: string) =>
  readRetainedJsonl(path.join(stateDir, DEPLOY_RESOURCE_LOG_FILE), isDeployResources);

export const deployResourcesAt = (entries: readonly DeployResources[], instant: string | Date): DeployResources | null =>
  entryAt(entries, instant, (entry) => entry.deployed_at);

/** Called only after the deployment record/report have been written successfully. */
export const appendDeployResources = async (
  stateDir: string, record: { name: string; created_at: string }, report: DeployResourceReport, reportBytes: string
): Promise<void> => {
  if (!report.recording) return;
  const entry = createDeployResources(record, report, reportBytes);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // Shared by project up and image up/release, independent of their deployment-store locks.
  const release = await acquirePidLock(path.join(stateDir, ".resource-log.lock"));
  try {
    appendRetainedJsonl(path.join(stateDir, DEPLOY_RESOURCE_LOG_FILE), entry, {
      keepMs: report.recording.keep_ms, now: new Date(),
      timeOf: (value) => value.deployed_at, isEntry: isDeployResources
    });
  } finally { await release(); }
};
