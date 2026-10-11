import path from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";

import { PublishedFileSyncError, syncFile, writeDurableFile } from "../filesystem/index.js";
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

/** Caller holds the publication lock; recover a published snapshot before using its history. */
export const reconcileDeploymentResources = async (recordPath: string): Promise<void> => {
  const previous = await priorRecord(recordPath);
  if (previous?.resource_snapshot && previous.recording) {
    await syncFile(recordPath);
    ensureDeployResources(recordPath, previous.resource_snapshot, previous.recording.keep_ms);
  }
};

/** The original non-recording publication sequence, including its temporary name and permissions. */
export const writeAtomicDeploymentFile = async (file: string, bytes: string): Promise<void> => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, bytes, "utf8");
  await rename(temporary, file);
};

/** Callers create the directory and pass the predecessor from their existing lifecycle read.
 * Recording replacements re-read under the lock; off never probes for recording state. */
export const publishDeploymentRecord = async (
  recordPath: string, record: DeploymentRecord, publishReport?: (durable: boolean) => Promise<void>,
  previous?: DeploymentRecord | null
): Promise<void> => {
  if (!record.recording && !previous?.recording) {
    await publishReport?.(false);
    await writeAtomicDeploymentFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return;
  }
  const release = await acquirePidLock(`${recordPath}.resource-log.lock`);
  try {
    await reconcileDeploymentResources(recordPath);
    await publishReport?.(true);
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
