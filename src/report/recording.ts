import path from "node:path";
import { z } from "zod";

const text = z.string().min(1);
const mountId = text.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u).refine((value) => !value.includes(".."));
const containerPath = text.startsWith("/").refine((value) => !value.includes("\0"));
const keepMs = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Portable compiled facts, persisted with the deployment so sync never recompiles. */
export const recordingAgentSchema = z.object({
  node_id: text,
  slug: text.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  directory: containerPath,
  keep_ms: keepMs,
  // Older reports omit the format and require the original recording directory.
  wake_format: text.optional(),
  networks: z.array(text),
  memory: z.array(z.object({ id: text, declared_by: text, ledger_path: containerPath.nullable() }).strict()),
  feeds: z.array(z.object({ id: text, volume_name: text }).strict()),
  resources: z.array(z.object({ id: text, kind: z.enum(["git", "bundle"]) }).strict()),
  snapshots: z.array(text)
}).strict().refine((value) => value.wake_format === undefined
  ? value.directory === `/var/lib/spawnfile/recording/${value.slug}`
  : value.directory.split("/").slice(1).every((part) => part && part !== "." && part !== "..")
    && path.posix.basename(value.directory) === value.slug, {
  message: "Recording directory must match the compiled agent slug"
});
export type RecordingAgentReport = z.infer<typeof recordingAgentSchema>;

/** Optional members preserve S1 records; sync requires the compiled agents member. */
export const recordingReportSchema = z.object({
  keep_ms: keepMs,
  memory_mount_ids: z.array(mountId),
  recording_mount_ids: z.array(mountId).optional(),
  agents: z.array(recordingAgentSchema).optional()
}).strict();
