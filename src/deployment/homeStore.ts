import path from "node:path";
import { readdir, rename, writeFile } from "node:fs/promises";

import { resolveSpawnfileHome } from "../auth/index.js";
import type { DistributionReport } from "../distribution/index.js";
import { ensureDirectory, readUtf8File } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import { normalizeDeploymentName } from "./names.js";
import { parseDeploymentRecord, type DeploymentRecord } from "./record.js";

export const resolveHomeDeploymentsDirectory = (): string =>
  path.join(resolveSpawnfileHome(), "deployments");

export const resolveHomeDeploymentDirectory = (deploymentName: string): string =>
  path.join(resolveHomeDeploymentsDirectory(), normalizeDeploymentName(deploymentName));

export const resolveHomeRecordPath = (deploymentName: string): string =>
  path.join(resolveHomeDeploymentDirectory(deploymentName), "record.json");

export const resolveHomeReportPath = (deploymentName: string): string =>
  path.join(resolveHomeDeploymentDirectory(deploymentName), "spawnfile-report.json");

const writeAtomic = async (filePath: string, content: string): Promise<void> => {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
};

/** Writes the record and the cached distribution report together, record last. */
export const writeHomeDeployment = async (
  record: DeploymentRecord,
  report: DistributionReport
): Promise<{ recordPath: string; reportPath: string }> => {
  const parsed = parseDeploymentRecord(record);
  const directory = resolveHomeDeploymentDirectory(parsed.name);
  await ensureDirectory(directory);

  const reportPath = resolveHomeReportPath(parsed.name);
  const recordPath = resolveHomeRecordPath(parsed.name);
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeAtomic(recordPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return { recordPath, reportPath };
};

export const readHomeDeploymentRecord = async (
  deploymentName: string
): Promise<DeploymentRecord> => {
  const recordPath = resolveHomeRecordPath(deploymentName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readUtf8File(recordPath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "validation_error",
      `Unable to read home deployment record ${recordPath}: ${reason}`
    );
  }
  return parseDeploymentRecord(parsed, recordPath);
};

export const readHomeDeploymentReport = async (
  deploymentName: string
): Promise<string> => readUtf8File(resolveHomeReportPath(deploymentName));

export const homeDeploymentExists = async (deploymentName: string): Promise<boolean> => {
  const records = await listHomeDeploymentRecords();
  const target = normalizeDeploymentName(deploymentName);
  return records.some((entry) => entry.record.name === target);
};

export const listHomeDeploymentRecords = async (): Promise<
  Array<{ path: string; record: DeploymentRecord }>
> => {
  const directory = resolveHomeDeploymentsDirectory();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "validation_error",
      `Unable to read home deployments directory ${directory}: ${reason}`
    );
  }

  const records = await Promise.all(
    entries
      .sort()
      .map(async (entry) => {
        const recordPath = path.join(directory, entry, "record.json");
        try {
          const parsed = JSON.parse(await readUtf8File(recordPath));
          return { path: recordPath, record: parseDeploymentRecord(parsed, recordPath) };
        } catch {
          return null;
        }
      })
  );

  return records
    .filter((entry): entry is { path: string; record: DeploymentRecord } => entry !== null)
    .sort((left, right) => left.record.name.localeCompare(right.record.name));
};
