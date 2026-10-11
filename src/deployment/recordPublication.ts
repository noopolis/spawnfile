import path from "node:path";
import { readFile } from "node:fs/promises";

import { ensureDirectory, PublishedFileSyncError, syncFile, writeDurableFile } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";
import { acquirePidLock } from "./pidLock.js";
import { parseDeploymentRecord, type DeploymentRecord } from "./record.js";
import { createDeployResources, ensureDeployResources, type DeployResourceReport } from "./resourceLog.js";

/** Publication succeeded: callers must not roll back its named container. */
export class HomeDeploymentRecordingError extends SpawnfileError {
  public constructor(deployment: string, cause: unknown) {
    super("io_error", `Deployment ${deployment} is published, but recording failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export const bindDeploymentRecording = (
  recordPath: string, record: DeploymentRecord, report: DeployResourceReport, reportBytes: string
): DeploymentRecord => {
  const { recording: _recording, resource_snapshot: _snapshot, ...base } = record;
  return report.recording ? { ...base, recording: report.recording,
    resource_snapshot: createDeployResources(recordPath, record, report, reportBytes) } : base;
};

const priorRecord = async (recordPath: string): Promise<DeploymentRecord | null> => {
  let bytes: string;
  try { bytes = await readFile(recordPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return parseDeploymentRecord(JSON.parse(bytes), recordPath);
};

/** The record embeds its pins so recompilation/failed report replacement cannot erase pending history. */
export const publishDeploymentRecord = async (
  recordPath: string, record: DeploymentRecord, publishReport?: () => Promise<void>
): Promise<void> => {
  await ensureDirectory(path.dirname(recordPath));
  const prior = await priorRecord(recordPath);
  // With recording off and no outstanding recorded predecessor, no history/lock I/O.
  const release = record.recording || prior?.recording
    ? await acquirePidLock(`${recordPath}.resource-log.lock`) : async () => undefined;
  try {
    const previous = await priorRecord(recordPath);
    if (previous?.resource_snapshot && previous.recording) {
      await syncFile(recordPath);
      ensureDeployResources(recordPath, previous.resource_snapshot, previous.recording.keep_ms);
    }
    await publishReport?.();
    try { await writeDurableFile(recordPath, `${JSON.stringify(record, null, 2)}\n`); }
    catch (cause) {
      if (cause instanceof PublishedFileSyncError) throw new HomeDeploymentRecordingError(record.name, cause);
      throw cause;
    }
    try {
      if (record.resource_snapshot && record.recording) ensureDeployResources(recordPath, record.resource_snapshot, record.recording.keep_ms);
    } catch (cause) { throw new HomeDeploymentRecordingError(record.name, cause); }
  } finally { await release(); }
};
