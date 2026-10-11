import path from "node:path";
import { ensureDirectory } from "../filesystem/index.js";
import { acquirePidLock } from "./pidLock.js";
import { createDeployResources, ensureDeployResources, type DeploymentActivation, type DeployResourceReport, type DeployResources } from "./resourceLog.js";

/** A candidate may execute turns before failing readiness/publication. Preserve its pins
 * after rollback, without replacing the still-authoritative predecessor's record. */
export const recordDeploymentRollback = async (
  recordPath: string,
  record: DeploymentActivation & { name: string; created_at: string; resource_snapshot?: DeployResources },
  report: DeployResourceReport,
  reportBytes: string,
  rolledBackAt: string
): Promise<void> => {
  if (!report.recording) return;
  await ensureDirectory(path.dirname(recordPath));
  const release = await acquirePidLock(`${recordPath}.resource-log.lock`);
  try {
    ensureDeployResources(recordPath, {
      ...(record.resource_snapshot ?? createDeployResources(recordPath, record, report, reportBytes)),
      rolled_back_at: rolledBackAt, activation_exact: false, exact: false,
      activation_note: "Candidate ran before rollback; its turns cannot be distinguished from predecessor turns"
    }, report.recording.keep_ms);
  } finally { await release(); }
};
