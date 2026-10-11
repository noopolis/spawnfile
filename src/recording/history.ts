import { deployResourcesAt, type DeployResources } from "../deployment/index.js";
import type { RecordingAgentReport } from "../report/index.js";

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
