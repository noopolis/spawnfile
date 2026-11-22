import path from "node:path";
import { z } from "zod";

import type { History } from "../../compiler/training/rewind/history.js";
import { safeSegment } from "../../compiler/training/rewind/historyIdentity.js";
import { trainingInstantSchema } from "../../manifest/index.js";
import { DAIMON_WAKE_MOMENTS } from "./wakeMoments.js";

const unsigned = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const nanos = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);
const mode = z.number().int().min(0).max(0xffff);
const relativePath = z.string().min(1).refine((value) => !value.includes("\\") && !value.includes("\0")
  && !path.posix.isAbsolute(value) && !value.split("/").some((part) => !part || part === "." || part === ".."),
"Snapshot paths must be normalized relative POSIX paths");
const sourceIdentity = z.object({ dev: unsigned, ino: unsigned, size: unsigned, mtimeNs: nanos, ctimeNs: nanos, mode }).strict();
const entrySchema = z.object({ type: z.enum(["file", "directory", "symlink"]), mode, size: unsigned,
  source: sourceIdentity, target: z.string().refine((value) => !value.includes("\0")).optional() }).strict().superRefine((entry, ctx) => {
  if ((entry.type === "symlink") !== (entry.target !== undefined)) ctx.addIssue({ code: "custom", message: "Only snapshot symlinks require a target" });
  if (entry.mode !== entry.source.mode || entry.size !== entry.source.size) ctx.addIssue({ code: "custom", message: "Snapshot source identity disagrees with entry metadata" });
  const typeMode = { file: 0o100000, directory: 0o040000, symlink: 0o120000 }[entry.type];
  if ((entry.mode & 0o170000) !== typeMode) ctx.addIssue({ code: "custom", message: "Snapshot mode disagrees with entry type" });
});

/** Daimon's manifest records source identity, not the identity of retained/copied inodes. */
export const snapshotManifestSchema = z.object({ version: z.literal(DAIMON_WAKE_MOMENTS.version), id: z.string().min(1),
  snapshot: z.string().min(1), started_at: trainingInstantSchema,
  sourcePath: z.string().refine((value) => path.posix.isAbsolute(value) && !value.includes("\0"), "Expected an absolute snapshot sourcePath"),
  entries: z.record(relativePath, entrySchema) }).strict().superRefine((manifest, ctx) => {
  for (const name of Object.keys(manifest.entries)) {
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (manifest.entries[parent]?.type !== "directory") ctx.addIssue({ code: "custom", message: `Snapshot parent ${parent} must be a recorded directory` });
    }
  }
});
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

export const snapshotHistoryPath = (agentSlug: string, id: string, snapshot: string): string =>
  `recording/${safeSegment(agentSlug)}/${DAIMON_WAKE_MOMENTS.snapshotsDirectory}/${safeSegment(id === "." || id === ".." ? id.replaceAll(".", "%2E") : id)}/${safeSegment(snapshot)}`;

export const readSnapshotManifest = async (history: History, relative: string, id: string, snapshot: string): Promise<SnapshotManifest | null> => {
  // Daimon publishes this marker only after the tree and manifest are durable.
  if (await history.bytes(`${relative}${DAIMON_WAKE_MOMENTS.completionSuffix}`) === null) return null;
  const bytes = await history.text(`${relative}.manifest.json`);
  if (bytes === null) return null;
  let manifest: SnapshotManifest;
  try { manifest = snapshotManifestSchema.parse(JSON.parse(bytes)); }
  catch (error) { throw new Error(`Invalid snapshot manifest ${relative}.manifest.json: ${error instanceof Error ? error.message : String(error)}`); }
  if (manifest.id !== id || manifest.snapshot !== snapshot) throw new Error(`Snapshot manifest identity mismatch at ${relative}.manifest.json`);
  return manifest;
};

/** Locations inside an exported historical recording, never in a live container. */
export const wakeHistoryPath = (agentSlug: string): string =>
  `recording/${safeSegment(agentSlug)}/${DAIMON_WAKE_MOMENTS.rowsFile}`;

export const isPartialSnapshot = (snapshot: string): boolean => snapshot.endsWith(".partial");

/** Private recorder directories have no retained source permissions. */
export const retainedSnapshotMode = (type: "file" | "directory" | "symlink", mode: number): number | null =>
  type === "directory" ? null : mode & (type === "file" ? 0o777 : 0o7777);
