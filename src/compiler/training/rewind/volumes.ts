import { lstat, mkdir } from "node:fs/promises";
import { z } from "zod";
import { trainingInstantSchema } from "../../../manifest/index.js";
import { safeSegment, type History } from "./history.js";
import { compareInstants } from "./instant.js";
import { copySnapshotTree, readSnapshotManifest, snapshotHistoryPath, type SnapshotManifest } from "./snapshotManifest.js";
import type { InputContext, InputResult } from "./types.js";

const text = z.string().min(1), count = z.number().int().nonnegative();
export const wakeSnapshotRowSchema = z.object({ version: z.literal("noopolis.daimon.wake-moment.v1"),
  agent_id: text, execution_id: text, started_at: trainingInstantSchema,
  deliveries: z.array(z.object({ acceptance_id: text, delivery_id: text, kind: text, occurred_at: trainingInstantSchema }).strict()),
  snapshots: z.array(z.object({ id: text, snapshot: text, files: count, copied: count, linked: count, skipped: count }).strict()),
  error: text.optional() }).strict();
export type WakeSnapshotRow = z.infer<typeof wakeSnapshotRowSchema>;
export interface SelectedVolumeSnapshot { snapshot: string; startedAt: string; manifest: SnapshotManifest; relative: string }

/** A published row plus retained directory and manifest is complete; never infer time from its name. */
export const selectVolumeSnapshot = async (history: History, agentSlug: string, agentId: string, id: string,
  at: string, recordId?: string): Promise<SelectedVolumeSnapshot> => {
  const rowsPath = `recording/${safeSegment(agentSlug)}/wake-moments.jsonl`;
  const rows = await history.jsonl(rowsPath, wakeSnapshotRowSchema);
  if (!rows) throw new Error(`Missing volume snapshot history ${rowsPath}`);
  const candidates = rows.flatMap((row, index) => row.agent_id !== agentId ? [] : row.snapshots.filter((entry) => entry.id === id)
    .map((entry) => ({ row, entry, index })))
    .filter(({ row, entry }) => recordId === undefined ? compareInstants(row.started_at, at) <= 0 : entry.snapshot === recordId)
    .sort((a, b) => compareInstants(b.row.started_at, a.row.started_at) || b.index - a.index);
  for (const { row, entry } of candidates) {
    if (entry.snapshot.endsWith(".partial")) {
      if (recordId !== undefined) throw new Error(`Recorded volume snapshot ${recordId} is partial`);
      continue;
    }
    if (compareInstants(row.started_at, at) > 0) throw new Error(`Recorded volume snapshot ${entry.snapshot} is later than the moment`);
    const relative = snapshotHistoryPath(agentSlug, id, entry.snapshot), tree = await history.path(relative);
    const manifest = await readSnapshotManifest(history, relative, id, entry.snapshot);
    if (!tree || !manifest) {
      if (recordId !== undefined) throw new Error(`Recorded volume snapshot ${recordId} is incomplete`);
      continue;
    }
    if (!(await lstat(tree)).isDirectory()) throw new Error(`Snapshot tree must be a real directory: ${relative}`);
    if (compareInstants(manifest.started_at, row.started_at) !== 0) throw new Error(`Snapshot manifest started_at disagrees with its wake row: ${relative}`);
    return { snapshot: entry.snapshot, startedAt: row.started_at, manifest, relative };
  }
  if (recordId !== undefined) throw new Error(`Recorded volume snapshot ${recordId} is absent from ${rowsPath}`);
  throw new Error("No complete volume snapshot was taken at or before the moment");
};

export const materializeVolume = async (context: InputContext): Promise<InputResult> => {
  const { input, at, record, history, destination } = context;
  if (input.section !== "resources" || input.declaration.kind !== "volume" || input.declaration.feed) {
    throw new Error("Volume materialization requires an unfed volume input");
  }
  if (input.overridden) {
    await mkdir(destination, { recursive: true });
    return { fidelity: "overridden", basis: "override", source: {}, notes: [], instant: at };
  }
  if (!history) throw new Error(`Volume ${input.id} requires --history or an override`);
  if (!context.agentSlug || !context.agentId) throw new Error("Volume snapshots require the compiled agent slug and identity");
  const pin = record?.volumes.find((entry) => entry.id === input.id);
  const selected = await selectVolumeSnapshot(history, context.agentSlug, context.agentId, input.id, at, pin?.snapshot);
  await copySnapshotTree(history, selected.relative, destination, selected.manifest);
  return { fidelity: pin ? "exact" : "approximate", basis: pin ? "record" : "snapshot-at",
    source: { snapshot: selected.snapshot, agentSlug: context.agentSlug }, notes: [], instant: selected.startedAt };
};
