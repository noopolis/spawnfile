import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { trainingInstantSchema } from "../../../manifest/index.js";
import { historyKey } from "./history.js";
import { compareInstants } from "./instant.js";
import type { InputContext, InputResult } from "./types.js";

const snapshotId = z.string().min(1);
const relativeFile = z.string().min(1).refine((value) => !value.includes("\\") && !value.includes("\0")
  && !path.posix.isAbsolute(value) && !value.split("/").some((part) => !part || part === "." || part === ".."),
"Snapshot file paths must be normalized relative POSIX paths");
export const volumeSnapshotSchema = z.object({
  snapshot: snapshotId, takenAt: trainingInstantSchema, parent: snapshotId.nullable(),
  files: z.record(relativeFile, z.string().regex(/^[a-f0-9]{64}$/u).nullable())
}).strict();
export type VolumeSnapshot = z.infer<typeof volumeSnapshotSchema>;
export interface ReplayedVolumeSnapshot {
  snapshot: string; takenAt: string; files: Record<string, string>; chain: VolumeSnapshot[];
}

const catalog = (snapshots: VolumeSnapshot[]): Map<string, VolumeSnapshot> => {
  const result = new Map<string, VolumeSnapshot>();
  for (const item of snapshots) {
    volumeSnapshotSchema.parse(item);
    if (result.has(item.snapshot)) throw new Error(`Duplicate volume snapshot ${item.snapshot}`);
    result.set(item.snapshot, item);
  }
  return result;
};

/** Replay metadata only. Both materialization and the independent disk checker can call this. */
export const replayVolumeSnapshot = (snapshots: VolumeSnapshot[], snapshot: string): ReplayedVolumeSnapshot => {
  const entries = catalog(snapshots), seen = new Set<string>(), chain: VolumeSnapshot[] = [];
  let next: string | null = snapshot;
  while (next !== null) {
    if (seen.has(next)) throw new Error(`Cycle in volume snapshot chain at ${next}`);
    seen.add(next);
    const current = entries.get(next);
    if (!current) throw new Error(`Missing volume snapshot ancestor ${next}`);
    const descendant = chain.at(-1);
    if (descendant && compareInstants(current.takenAt, descendant.takenAt) > 0) {
      throw new Error(`Volume snapshot parent ${next} is later than child ${descendant.snapshot}`);
    }
    chain.push(current); next = current.parent;
  }
  chain.reverse();
  const files = new Map<string, string>();
  for (const item of chain) {
    for (const [file, digest] of Object.entries(item.files)) {
      if (digest === null) files.delete(file); else files.set(file, digest);
    }
    for (const file of files.keys()) {
      const components = file.split("/");
      for (let length = 1; length < components.length; length++) {
        const parent = components.slice(0, length).join("/");
        if (files.has(parent)) throw new Error(`Snapshot ${item.snapshot} has a file/directory collision at ${parent}`);
      }
    }
  }
  return { snapshot, takenAt: chain.at(-1)!.takenAt,
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))), chain };
};

export const selectVolumeSnapshot = (snapshots: VolumeSnapshot[], at: string, recordId?: string): VolumeSnapshot => {
  const entries = catalog(snapshots);
  const candidates = [...entries.values()].filter((item) => compareInstants(item.takenAt, at) <= 0)
    .sort((a, b) => compareInstants(b.takenAt, a.takenAt));
  if (!candidates.length) throw new Error("No volume snapshot was taken at or before the moment");
  let selected = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (compareInstants(candidate.takenAt, selected.takenAt) !== 0) break;
    if (replayVolumeSnapshot(snapshots, candidate.snapshot).chain.some((item) => item.snapshot === selected.snapshot)) {
      selected = candidate;
    } else if (!replayVolumeSnapshot(snapshots, selected.snapshot).chain.some((item) => item.snapshot === candidate.snapshot)) {
      throw new Error("Ambiguous volume snapshots taken at the same instant on separate branches");
    }
  }
  const chain = replayVolumeSnapshot(snapshots, selected.snapshot).chain;
  if (recordId !== undefined) {
    const pinned = chain.find((item) => item.snapshot === recordId);
    if (!pinned) throw new Error(`Recorded volume snapshot ${recordId} is not the latest eligible snapshot or its ancestor`);
    return pinned;
  }
  return selected;
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
  const base = `volumes/${historyKey(input)}`;
  const snapshots = await history.jsonl(`${base}/snapshots.jsonl`, volumeSnapshotSchema);
  if (!snapshots) throw new Error(`Missing volume snapshot history ${base}/snapshots.jsonl`);
  const pin = record?.volumes.find((entry) => entry.id === input.id);
  const selected = selectVolumeSnapshot(snapshots, at, pin?.snapshot);
  const replayed = replayVolumeSnapshot(snapshots, selected.snapshot);
  const objects = new Map<string, Buffer>();
  // Verify every object referenced by the replay, including content later overwritten or deleted.
  for (const item of replayed.chain) for (const digest of Object.values(item.files)) {
    if (digest === null || objects.has(digest)) continue;
    const objectPath = `${base}/objects/${digest}`, bytes = await history.bytes(objectPath);
    if (bytes === null) throw new Error(`Missing volume snapshot object ${objectPath}`);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error(`Volume snapshot object SHA-256 mismatch: ${objectPath}`);
    objects.set(digest, bytes);
  }
  await mkdir(destination, { recursive: true });
  for (const [file, digest] of Object.entries(replayed.files)) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, objects.get(digest)!);
  }
  return { fidelity: pin ? "exact" : "approximate", basis: pin ? "record" : "snapshot-at",
    source: { snapshot: selected.snapshot }, notes: [], instant: selected.takenAt };
};
