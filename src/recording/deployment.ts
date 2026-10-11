import { execFileSync } from "node:child_process";

import {
  createDockerProbeGateway, dockerContextNameForTarget, inspectDockerDeployment,
  type DeploymentRecord
} from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";
import { readFeedLandings, resolveFeedStateDirectory } from "../volume/index.js";
import { syncMomentRecords, type SyncMomentRecordsOptions, type SyncMomentRecordsResult } from "./sync.js";

export interface RecordingDeploymentHandlers {
  createDockerProbeGateway?: typeof createDockerProbeGateway;
  inspectDockerDeployment?: typeof inspectDockerDeployment;
  readFeedHistory?: SyncMomentRecordsOptions["readFeedHistory"];
  now?: () => Date;
}
export interface RecordingDeploymentOptions {
  record: DeploymentRecord;
  recordPath: string;
  dockerCommand?: string;
  timeoutMs?: number;
}

export const syncDeploymentMoments = async (
  options: RecordingDeploymentOptions, handlers: RecordingDeploymentHandlers = {}
): Promise<SyncMomentRecordsResult> => {
  const { record, recordPath } = options;
  if (record.recording && !record.recording.agents) {
    throw new SpawnfileError("runtime_error", "Deployment predates compiled recording facts; recompile and redeploy before record sync");
  }
  const agents = record.recording?.agents ?? [];
  if (!agents.length) return { written: 0, skipped: 0, nonExact: 0, failures: [], warnings: [] };
  const inspections = await (handlers.inspectDockerDeployment ?? inspectDockerDeployment)(record, {
    dockerCommand: options.dockerCommand, timeoutMs: options.timeoutMs
  });
  const gatewayFor = handlers.createDockerProbeGateway ?? createDockerProbeGateway;
  const context = dockerContextNameForTarget(record.target);
  const dockerTarget = context ? ["--context", context] : record.target.kind === "host" ? ["--host", record.target.value] : [];
  return syncMomentRecords({
    recordPath, agents, now: handlers.now,
    execForAgent: (agent) => {
      const units = record.units.filter((unit) => unit.contains.some((entry) => entry.kind === "agent" && entry.id === agent.node_id));
      if (units.length !== 1) throw new Error(`Expected one deployment unit for ${agent.node_id}, found ${units.length}`);
      const unit = units[0]!, inspection = inspections.get(unit.id);
      if (inspection?.running !== true) throw new Error(`Container ${unit.id} is stopped or unreachable`);
      const gateway = gatewayFor(record, unit, { inspection, dockerCommand: options.dockerCommand, timeoutMs: options.timeoutMs });
      return (command) => gateway.exec(command);
    },
    readFeedHistory: handlers.readFeedHistory ?? (async (feed) => {
      const state = resolveFeedStateDirectory(feed.volume_name, { exec: (_command, args) => execFileSync(
        options.dockerCommand ?? "docker", [...dockerTarget, ...args], { timeout: options.timeoutMs ?? 30_000, maxBuffer: 1024 * 1024 }
      ) });
      return readFeedLandings(state);
    })
  });
};
