import path from "node:path";
import { readdir, rename, writeFile } from "node:fs/promises";

import { z } from "zod";

import {
  ensureDirectory,
  readUtf8File
} from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import { parseOrganizationHandoff, type OrganizationHandoff } from "./organizationHandoffTypes.js";
import { parseOpaqueTargetHandle, type OpaqueTargetHandle } from "../target/index.js";

import {
  normalizeDeploymentName,
  resolveDeploymentRecordPath,
  resolveDeploymentRecordsDirectory
} from "./names.js";
import {
  parseOrganizationReadiness,
  organizationReadinessSchema,
  type OrganizationReadiness
} from "./organizationReady.js";

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

const unitV1Schema = z.object({
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

const unitSchema = z.object({
  container_id: z.string().min(1).nullable(),
  container_name: z.string().min(1).nullable(),
  contains: z.array(z.object({
    id: z.string().min(1),
    kind: z.union([z.literal("agent"), z.literal("network"), z.literal("team")])
  }).strict()),
  id: z.string().min(1),
  image_id: z.string().min(1).nullable(),
  image_tag: z.string().min(1),
  kind: z.literal("container"),
  manager: z.string().min(1).optional(),
  runtime_instances: z.array(z.string().min(1)),
  target: targetSchema.optional()
}).strict();

const recordSourceSchema = z.union([
  z.object({
    kind: z.literal("project"),
    root: z.string().min(1)
  }).strict(),
  z.object({
    digest: z.string().min(1).nullable(),
    kind: z.literal("image"),
    ref: z.string().min(1)
  }).strict()
]);

export type DeploymentRecordSource = z.infer<typeof recordSourceSchema>;

const deploymentRecordV1Schema = z.object({
  auth_profile: z.string().min(1).nullable(),
  compile_fingerprint: z.string().min(1),
  created_at: z.string().min(1),
  env_file: z.string().min(1).optional(),
  manager: z.literal("docker"),
  name: z.string().min(1),
  output_directory: z.string().min(1),
  project_root: z.string().min(1),
  target: targetSchema,
  units: z.array(unitV1Schema).min(1),
  version: z.literal("spawnfile.deployment.v1")
}).strict();

export const deploymentRecordSchema = z.object({
  auth_profile: z.string().min(1).nullable(),
  compile_fingerprint: z.string().min(1),
  created_at: z.string().min(1),
  env_file: z.string().min(1).optional(),
  manager: z.string().min(1),
  name: z.string().min(1),
  organization_handoff: z.unknown().optional(),
  organization_handoff_handle: z.string().optional(),
  output_directory: z.string().min(1).nullable(),
  // Optional: the NOOPOLIS_RUN_ID stamped on every authority container's
  // causal events for this deployment's run (see specs/CAUSAL.md and
  // src/runtime/common.ts). Populated only when the compiling process had a
  // run id set (every `spawnfile run`/`up --detach` invocation via
  // ensureNoopolisRunId()); absent for image-consume/recovered records that
  // have no reliable run-time id to source. This is what lets
  // `spawnfile artifacts export --run-id <id>` find the deployment whose
  // containers/volumes were compiled under that run.
  run_id: z.string().min(1).optional(),
  source: recordSourceSchema,
  target: targetSchema,
  units: z.array(unitSchema).min(1),
  version: z.literal("spawnfile.deployment.v2"),
  // Optional: stamped by `spawnfile artifacts export` (artifactsExport.ts) once it has
  // successfully written `spawnfile.export-index.v1` for this deployment's run. This is
  // the record-driven marker `spawnfile down` (downDeployment.ts) reads to enforce the
  // export-before-teardown invariant (Decision 21) without needing to be told, out of
  // band, where a prior export went: down resolves the SAME deployment record export
  // already writes back to, so the two commands share one source of truth. Absent means
  // "never exported" — not "exported to an unknown location".
  export_index: z.object({
    exported_at: z.string().min(1),
    path: z.string().min(1),
    run_id: z.string().min(1)
  }).strict().optional(),
  organization_ready: organizationReadinessSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.organization_handoff_handle !== undefined && value.organization_handoff === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["organization_handoff_handle"], message: "organization handoff handle requires organization handoff" });
  }
});

export type DeploymentRecord = Omit<z.infer<typeof deploymentRecordSchema>, "organization_handoff" | "organization_handoff_handle" | "organization_ready"> & {
  organization_handoff?: OrganizationHandoff;
  organization_handoff_handle?: OpaqueTargetHandle;
  organization_ready?: OrganizationReadiness;
};

const upgradeV1Record = (
  record: z.infer<typeof deploymentRecordV1Schema>
): DeploymentRecord => ({
  auth_profile: record.auth_profile,
  compile_fingerprint: record.compile_fingerprint,
  created_at: record.created_at,
  ...(record.env_file ? { env_file: record.env_file } : {}),
  manager: record.manager,
  name: record.name,
  output_directory: record.output_directory,
  source: { kind: "project", root: record.project_root },
  target: record.target,
  units: record.units,
  version: "spawnfile.deployment.v2"
});

const hasVersion = (source: unknown, version: string): boolean =>
  typeof source === "object"
  && source !== null
  && (source as { version?: unknown }).version === version;

const readOrganizationReadiness = (source: unknown): OrganizationReadiness | undefined => {
  if (typeof source !== "object" || source === null || !Object.hasOwn(source, "organization_ready")) {
    return undefined;
  }
  return parseOrganizationReadiness(
    (source as { organization_ready: unknown }).organization_ready
  );
};

export const parseDeploymentRecord = (
  source: unknown,
  sourceLabel = "deployment record"
): DeploymentRecord => {
  const organizationReadiness = readOrganizationReadiness(source);
  let record: DeploymentRecord;
  if (hasVersion(source, "spawnfile.deployment.v1")) {
    const parsed = deploymentRecordV1Schema.safeParse(source);
    if (!parsed.success) {
      throw new SpawnfileError(
        "validation_error",
        `Invalid ${sourceLabel}: ${z.prettifyError(parsed.error)}`
      );
    }
    record = upgradeV1Record(parsed.data);
  } else {
    const parsed = deploymentRecordSchema.safeParse(source);
    if (!parsed.success) {
      throw new SpawnfileError(
        "validation_error",
        `Invalid ${sourceLabel}: ${z.prettifyError(parsed.error)}`
      );
    }
    const {
      organization_handoff: organizationHandoff,
      organization_handoff_handle: organizationHandoffHandle,
      organization_ready: _organizationReady,
      ...recordWithoutMetadata
    } = parsed.data;
    record = {
      ...recordWithoutMetadata,
      ...(organizationHandoff === undefined
        ? {}
        : { organization_handoff: parseOrganizationHandoff(organizationHandoff) }),
      ...(organizationHandoffHandle === undefined ? {} : { organization_handoff_handle: parseOpaqueTargetHandle(organizationHandoffHandle) })
    } as DeploymentRecord;
  }

  const normalizedName = normalizeDeploymentName(record.name);
  if (normalizedName !== record.name) {
    throw new SpawnfileError(
      "validation_error",
      `Invalid ${sourceLabel}: deployment name must be normalized`
    );
  }

  return organizationReadiness ? { ...record, organization_ready: organizationReadiness } : record;
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
