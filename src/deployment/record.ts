import path from "node:path";
import { readdir, rename, writeFile } from "node:fs/promises";

import { z } from "zod";

import {
  ensureDirectory,
  readUtf8File
} from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import {
  normalizeDeploymentName,
  resolveDeploymentRecordPath,
  resolveDeploymentRecordsDirectory
} from "./names.js";

const contextTargetSchema = z.object({
  endpoint_fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/),
  kind: z.literal("context"),
  name: z.string().min(1)
}).strict();

const legacyContextTargetSchema = z.object({
  context: z.string().min(1),
  endpoint_fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/),
  kind: z.literal("docker-context")
}).strict();

const hostTargetSchema = z.object({
  kind: z.literal("host"),
  value: z.string().min(1)
}).strict();

const targetSchema = z.union([
  contextTargetSchema,
  legacyContextTargetSchema,
  hostTargetSchema
]);

const unitSchema = z.object({
  container_id: z.string().min(1).nullable(),
  container_name: z.string().min(1).nullable(),
  contains: z.array(z.object({
    id: z.string().min(1),
    kind: z.union([z.literal("agent"), z.literal("team")])
  }).strict()),
  id: z.string().min(1),
  image_id: z.string().min(1).nullable(),
  image_tag: z.string().min(1),
  kind: z.literal("container"),
  runtime_instances: z.array(z.string().min(1))
}).strict();

export const deploymentRecordSchema = z.object({
  auth_profile: z.string().min(1).nullable(),
  compile_fingerprint: z.string().min(1),
  created_at: z.string().min(1),
  env_file: z.string().min(1).optional(),
  manager: z.literal("docker"),
  name: z.string().min(1),
  output_directory: z.string().min(1),
  project_root: z.string().min(1),
  target: targetSchema,
  units: z.array(unitSchema).min(1),
  version: z.literal("spawnfile.deployment.v1")
}).strict();

export type DeploymentRecord = z.infer<typeof deploymentRecordSchema>;

export const parseDeploymentRecord = (
  source: unknown,
  sourceLabel = "deployment record"
): DeploymentRecord => {
  const parsed = deploymentRecordSchema.safeParse(source);
  if (!parsed.success) {
    throw new SpawnfileError(
      "validation_error",
      `Invalid ${sourceLabel}: ${z.prettifyError(parsed.error)}`
    );
  }

  const normalizedName = normalizeDeploymentName(parsed.data.name);
  if (normalizedName !== parsed.data.name) {
    throw new SpawnfileError(
      "validation_error",
      `Invalid ${sourceLabel}: deployment name must be normalized`
    );
  }

  return parsed.data;
};

export const readDeploymentRecord = async (recordPath: string): Promise<DeploymentRecord> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readUtf8File(recordPath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "validation_error",
      `Unable to read deployment record ${recordPath}: ${reason}`
    );
  }

  return parseDeploymentRecord(parsed, recordPath);
};

export const readDeploymentRecordFromOutput = async (
  outputDirectory: string,
  deploymentName: string
): Promise<DeploymentRecord> =>
  readDeploymentRecord(resolveDeploymentRecordPath(outputDirectory, deploymentName));

export const listDeploymentRecords = async (
  outputDirectory: string
): Promise<Array<{ path: string; record: DeploymentRecord }>> => {
  const recordsDirectory = resolveDeploymentRecordsDirectory(outputDirectory);
  let entries: string[];
  try {
    entries = await readdir(recordsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "validation_error",
      `Unable to read deployment records directory ${recordsDirectory}: ${reason}`
    );
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map(async (entry) => {
        const recordPath = path.join(recordsDirectory, entry);
        return {
          path: recordPath,
          record: await readDeploymentRecord(recordPath)
        };
      })
  );

  return records.sort((left, right) => left.record.name.localeCompare(right.record.name));
};

export const writeDeploymentRecord = async (
  outputDirectory: string,
  record: DeploymentRecord
): Promise<string> => {
  const parsed = parseDeploymentRecord(record);
  const recordPath = resolveDeploymentRecordPath(outputDirectory, parsed.name);
  await ensureDirectory(path.dirname(recordPath));

  const temporaryPath = path.join(
    path.dirname(recordPath),
    `.${path.basename(recordPath)}.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(temporaryPath, recordPath);
  return recordPath;
};
