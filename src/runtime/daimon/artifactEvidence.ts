import path from "node:path/posix";

import type { RuntimeExportFile, RuntimeOperations, RuntimeUsageOperations } from "../operations.js";
import { DAIMON_ORGANIZATION_TARGET_ID, DAIMON_USAGE_MOUNT_ID } from "./config.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "./contractManifest.js";
import { parseUsageLedger } from "./usageLedger.js";

const { directoryPath, filePath, rotatedFilePath, rotateBytes } = DAIMON_GROK_TURN_USAGE_LEDGER;
const volumePaths = {
  filePath: path.relative(directoryPath, filePath),
  rotatedFilePath: path.relative(directoryPath, rotatedFilePath)
};

export const daimonUsage: RuntimeUsageOperations = {
  matchesLegacyInstance: (id) => id === DAIMON_ORGANIZATION_TARGET_ID,
  livePaths: { filePath, rotatedFilePath },
  exportedPaths: {
    filePath: `raw/daimon/${volumePaths.filePath}`,
    rotatedFilePath: `raw/daimon/${volumePaths.rotatedFilePath}`
  },
  // Rotation occurs on the append after a generation crosses the threshold.
  maxReadBytes: 2 * rotateBytes,
  mountId: DAIMON_USAGE_MOUNT_ID,
  volumePaths,
  parse: parseUsageLedger
};

const agentNodePrefix = "agent:";
const agentSlug = (nodeId: string): string | null =>
  nodeId.startsWith(agentNodePrefix) ? nodeId.slice(agentNodePrefix.length)
    : nodeId.startsWith("team:") ? null : nodeId;

export const planDaimonFiles: NonNullable<RuntimeOperations["exportFiles"]> = (instance, mounts) =>
  (instance.node_ids ?? []).flatMap((nodeId): RuntimeExportFile[] => {
    const slug = agentSlug(nodeId);
    if (!slug) return [];
    const mountId = instance.telemetry_mount_ids?.[nodeId];
    const mount = mountId ? mounts.get(mountId) : undefined;
    const relativePath = `raw/daimon/${slug}/causal.jsonl`;
    if (mount) return [{
      optional: true, relativePath,
      source: { kind: "volume" as const, volumeName: mount.volume_name, volumePath: "causal.jsonl" }
    }];
    if (!instance.home_path) return [];
    const containerPath = `${path.dirname(instance.home_path)}/runtime/agents/${slug}/telemetry/causal.jsonl`;
    return [{ optional: true, relativePath, source: { kind: "container" as const, containerPath } }];
  });

export const planDaimonPrivateDirectories: NonNullable<RuntimeOperations["privateExportDirectories"]> = (instance) => {
  if (!instance.home_path) return [];
  const instanceRoot = path.dirname(instance.home_path);
  return (instance.node_ids ?? [])
    .filter((nodeId) => nodeId.startsWith(agentNodePrefix))
    .map((nodeId) => nodeId.slice(agentNodePrefix.length))
    .filter((slug) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(slug))
    .map((slug) => Object.freeze({
      containerPath: `${instanceRoot}/runtime/agents/${slug}/private-training/pi/raw`,
      relativePath: `private/daimon/${slug}/private-training/pi/raw`
    }));
};
