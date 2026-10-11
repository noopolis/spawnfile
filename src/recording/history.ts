import { acquirePidLock, deployResourcesAt, readDeployResources, reconcileDeploymentResources, type DeployResources } from "../deployment/index.js";
import type { RecordingAgentReport } from "../report/index.js";
import { acquireFeedLock, ensureFeedLanding, readFeedLanded, readFeedLandings, type FeedLanding } from "../volume/index.js";

export interface RecordingHistory<T> { entries: T[]; errors: string[]; publicationPending?: true }

export const readRecordingDeployHistory = async (recordPath: string): Promise<RecordingHistory<DeployResources>> => {
  try {
    const release = await acquirePidLock(`${recordPath}.resource-log.lock`);
    try {
      await reconcileDeploymentResources(recordPath);
      return readDeployResources(recordPath);
    } finally { await release(); }
  } catch {
    return { ...readDeployResources(recordPath), publicationPending: true };
  }
};

export const readRecordingFeedHistory = (stateDir: string, now: Date): RecordingHistory<FeedLanding> => {
  try {
    const lock = acquireFeedLock(stateDir);
    if (!lock) throw new Error("Feed history publication pending");
    try {
      const { record, reason } = readFeedLanded(stateDir);
      if (!record?.recording || reason) throw new Error(reason ?? "Missing authoritative feed recording");
      ensureFeedLanding({ stateDir }, record, now);
      return readFeedLandings(stateDir);
    } finally { lock.release(); }
  } catch {
    return { ...readFeedLandings(stateDir), publicationPending: true };
  }
};

/** Absence is unknown evidence, even for agents with no resource pins. Never use today's facts. */
export const recordingHistoryAt = (
  entries: readonly DeployResources[], recordPath: string, startedAt: string, agentNodeId: string
): { deployment: DeployResources | null; agent?: RecordingAgentReport; errors: string[] } => {
  const deployment = deployResourcesAt(entries, recordPath, startedAt, agentNodeId);
  if (!deployment) return { deployment, errors: [`Missing deployment history at ${startedAt}`] };
  const agents = deployment.recording_agents?.filter((agent) => agent.node_id === agentNodeId) ?? [];
  return agents.length === 1 ? { deployment, agent: agents[0]!, errors: [] } : {
    deployment, errors: [`${agents.length ? "Ambiguous" : "Missing"} activation recording facts for ${agentNodeId} at ${startedAt}`]
  };
};
