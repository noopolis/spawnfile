import type { RecordingReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";

export interface RecordedMemoryDeletionOptions {
  discardRecordedMemory?: boolean;
  removeVolumes?: boolean;
}

/** The recording report lists mount ids; deletion operates on resolved names.
 * Compare names after mapping so aliases cannot bypass the retention guard. */
export const assertRecordedMemoryRetention = <T extends { id: string }>(
  recording: RecordingReport | undefined,
  mounts: readonly T[],
  deleting: readonly string[],
  nameOf: (mount: T) => string,
  options: RecordedMemoryDeletionOptions,
  remedy = "pass --discard-recorded-memory with --volumes to deliberately discard them",
): void => {
  if (!recording || !options.removeVolumes || options.discardRecordedMemory) return;
  const protectedIds = new Set(recording.memory_mount_ids);
  const protectedNames = new Set(mounts.filter((mount) => protectedIds.has(mount.id)).map(nameOf));
  const protectedDeletions = [...new Set(deleting.filter((name) => protectedNames.has(name)))].sort();
  if (protectedDeletions.length > 0) {
    throw new SpawnfileError("runtime_error",
      `Recording retains memory ledgers in ${protectedDeletions.join(", ")}; ${remedy}`);
  }
};
