import path from "node:path";

import {
  buildCompilePlan,
  upProject,
  type UpProjectOptions,
  type UpProjectResult
} from "../compiler/index.js";
import {
  listDeploymentRecords,
  normalizeDeploymentName,
  type DeploymentRecord
} from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";
import { DEV_DEPLOYMENT_LINEAGE_NAMESPACE } from "../compiler/deploymentLineage.js";
import {
  defaultExecFile,
  dockerArgsForRecord,
  firstContainerName,
  runDocker,
  type DevExecFile
} from "./docker.js";

const DEV_OUTPUT_DIRECTORY = ".spawn-dev";

export interface DevProjectOptions {
  deploymentName?: string;
  dockerCommand?: string;
  outputDirectory?: string;
}

export interface DevStopProjectResult {
  containerName: string;
  deploymentName: string;
  outputDirectory: string;
}

export const resolveDevOutputDirectory = async (
  inputPath: string,
  outputDirectory?: string
): Promise<string> => {
  if (outputDirectory) {
    return path.resolve(outputDirectory);
  }
  const plan = await buildCompilePlan(inputPath);
  return path.join(path.dirname(plan.root), DEV_OUTPUT_DIRECTORY);
};

/**
 * A dev deployment gets its own lineage namespace so it can never resolve to
 * the derived volumes of a production `spawnfile up` of the same project —
 * before this, both defaulted to the lineage `default` and dev wrote into
 * production's state whenever production was stopped. The deployment NAME is
 * untouched, so dev records, labels, and `dev stop --deployment` are unchanged.
 */
export const devUpProject = async (
  inputPath: string,
  options: UpProjectOptions = {}
): Promise<UpProjectResult> => upProject(inputPath, {
  ...options,
  deploymentLineageNamespace: DEV_DEPLOYMENT_LINEAGE_NAMESPACE,
  detach: true,
  outputDirectory: await resolveDevOutputDirectory(inputPath, options.outputDirectory)
});

export const selectDeploymentRecord = async (
  outputDirectory: string,
  deploymentName?: string
): Promise<DeploymentRecord> => {
  const records = await listDeploymentRecords(outputDirectory);
  if (records.length === 0) {
    throw new SpawnfileError(
      "validation_error",
      `No dev deployment records found in ${outputDirectory}; run spawnfile dev up first`
    );
  }
  if (deploymentName) {
    const normalized = normalizeDeploymentName(deploymentName);
    const selected = records.find((entry) => entry.record.name === normalized);
    if (!selected) {
      throw new SpawnfileError(
        "validation_error",
        `Unknown dev deployment "${normalized}". Valid deployments: ${records.map((entry) => entry.record.name).join(", ")}`
      );
    }
    return selected.record;
  }
  if (records.length > 1) {
    throw new SpawnfileError(
      "validation_error",
      `--deployment is required: ${records.map((entry) => entry.record.name).join(", ")}`
    );
  }
  return records[0]!.record;
};

export const devStopProject = async (
  inputPath: string,
  options: DevProjectOptions & { execFile?: DevExecFile } = {}
): Promise<DevStopProjectResult> => {
  const outputDirectory = await resolveDevOutputDirectory(inputPath, options.outputDirectory);
  const record = await selectDeploymentRecord(outputDirectory, options.deploymentName);
  const containerName = firstContainerName(record);
  await runDocker(
    options.dockerCommand ?? "docker",
    [...dockerArgsForRecord(record), "rm", "-f", containerName],
    options.execFile ?? defaultExecFile
  );
  return { containerName, deploymentName: record.name, outputDirectory };
};
