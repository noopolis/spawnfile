import type { RecordingReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";
import type { DeploymentRecord } from "./record.js";

export interface RecordedMemoryDeletionOptions {
  discardRecordedMemory?: boolean;
  removeVolumes?: boolean;
}

/** A recompile cannot revoke deployed protection or change the mount-name mapping. */
export const recordedMemoryForDeletion = (
  record: DeploymentRecord,
  report: { compile_fingerprint?: string; recording?: RecordingReport } | null,
  mounts: readonly { id: string }[],
  options: RecordedMemoryDeletionOptions
): RecordingReport | undefined => {
  if (options.removeVolumes && !options.discardRecordedMemory) {
    const deployed = record.recording;
    const mismatch = report?.compile_fingerprint !== record.compile_fingerprint;
    const weakened = deployed && (!report?.recording || report.recording.keep_ms < deployed.keep_ms
      || deployed.memory_mount_ids.some((id) => !report.recording!.memory_mount_ids.includes(id) || !mounts.some((mount) => mount.id === id)));
    if ((deployed && mismatch) || weakened || (report?.recording && mismatch)) {
      throw new SpawnfileError("runtime_error", "Deployment record and report disagree; recording protection cannot be weakened. Restore the deployed report or pass --discard-recorded-memory with --volumes");
    }
  }
  return record.recording ?? report?.recording;
};

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
