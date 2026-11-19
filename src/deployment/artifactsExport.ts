import { createHash } from "node:crypto";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { ensureDirectory, fileExists, readUtf8File } from "../filesystem/index.js";
import { resolveOutputFilePaths, resolveOutputRoot } from "../filesystem/outputPaths.js";
import type { RuntimePrivateExportDirectory } from "../runtime/operations.js";
import type { CompileReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";
import { REPORT_FILENAME } from "../shared/index.js";

import {
  containerExists,
  copyContainerFileToHost,
  copyVolumeFileToHost,
  defaultDockerArtifactExecFile,
  type DockerArtifactExecFile
} from "./artifactsExportDocker.js";
import { EXPORT_INDEX_VERSION, type ExportIndex, type ExportIndexFile, type ExportIndexSource } from "./artifactsExportTypes.js";
import { planArtifactExports, type PlannedExportFile } from "./artifactsExportPlan.js";
import { EXPORT_INDEX_PATH, publishArtifactFiles, resolveArtifactOutputPaths } from "./artifactExportPublication.js";
import { exportPrivateRuntimeArtifacts, planPrivateArtifactExports } from "./privateArtifactsExport.js";
import {
  assertDeploymentLifecycleCorrelation,
  createDeploymentLifecycleCorrelation,
  type DeploymentLifecycleCorrelation,
} from "./deploymentLifecycleCorrelation.js";
import { listDeploymentRecords, readDeploymentRecordFromOutput, writeDeploymentRecord } from "./record.js";
import type { DeploymentRecord } from "./record.js";

export interface ExportRunArtifactsOptions {
  /** Where the deployment record + compile report already live (the compile's own
   * `--out` directory) — NOT the export destination. */
  compiledOutputDirectory: string;
  deploymentName?: string;
  /** Where `raw/**` and `spawnfile/export-index.json` are written. */
  destinationDirectory: string;
  dockerCommand?: string;
  execFile?: DockerArtifactExecFile;
  /** Explicitly export unredacted private runtime training artifacts. */
  includePrivate?: boolean;
  /** Overrides the image used to read named volumes; defaults to the deployment's own
   * recorded `image_tag` (already present locally — see artifactsExportDocker.ts). */
  readerImage?: string;
  runId?: string;
  timeoutMs?: number;
  expectedLifecycleCorrelation?: DeploymentLifecycleCorrelation;
}

export interface ExportRunArtifactsResult {
  deploymentName: string;
  /** Planned files that failed to copy despite the container/volume being reachable
   * (a real per-file problem, worth surfacing, as opposed to `missingOptionalFiles`).
   * When non-empty, nothing is promoted into the destination: no file, no index and no
   * deployment-record marker is written, so an earlier successful export stays intact. */
  failedFiles: string[];
  index: ExportIndex;
  /** Written only when `failedFiles` is empty. */
  indexPath: string;
  /** Planned files that were legitimately absent (e.g. no recall yet) — not failures. */
  missingOptionalFiles: string[];
}

const sha256Hex = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

const targetRefForUnit = (unit: DeploymentRecord["units"][number]): string | null =>
  unit.container_id ?? unit.container_name;

const resolveDeploymentRecord = async (
  compiledOutputDirectory: string,
  options: Pick<ExportRunArtifactsOptions, "deploymentName" | "runId">
): Promise<DeploymentRecord> => {
  if (options.deploymentName && options.runId) {
    throw new SpawnfileError(
      "validation_error",
      "spawnfile artifacts export accepts only one of --deployment or --run-id"
    );
  }
  if (!options.deploymentName && !options.runId) {
    throw new SpawnfileError(
      "validation_error",
      "spawnfile artifacts export requires --deployment <name> or --run-id <id>"
    );
  }

  if (options.deploymentName) {
    try {
      return await readDeploymentRecordFromOutput(compiledOutputDirectory, options.deploymentName);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SpawnfileError(
        "runtime_error",
        `No deployment record named "${options.deploymentName}" under ${compiledOutputDirectory}. ` +
          `Has it already been torn down, or never brought up with --detach? (${reason})`
      );
    }
  }

  const records = await listDeploymentRecords(compiledOutputDirectory);
  const match = records.find((entry) => entry.record.run_id === options.runId);
  if (!match) {
    const known = records.map((entry) => entry.record.name).sort().join(", ") || "none";
    throw new SpawnfileError(
      "runtime_error",
      `No deployment record found for run id "${options.runId}" under ${compiledOutputDirectory}. ` +
        `Known deployments: ${known}`
    );
  }
  return match.record;
};

export const resolveArtifactsExportLifecycleCorrelation = async (
  options: Pick<
    ExportRunArtifactsOptions,
    "compiledOutputDirectory" | "deploymentName" | "runId"
  >
): Promise<DeploymentLifecycleCorrelation> =>
  createDeploymentLifecycleCorrelation(
    await resolveDeploymentRecord(
      path.resolve(options.compiledOutputDirectory),
      options
    )
  );

const readCompileReport = async (compiledOutputDirectory: string): Promise<CompileReport> => {
  const reportPath = path.join(compiledOutputDirectory, REPORT_FILENAME);
  if (!(await fileExists(reportPath))) {
    throw new SpawnfileError(
      "validation_error",
      `No compile report found at ${reportPath}; recompile the project before exporting artifacts.`
    );
  }
  const parsed = JSON.parse(await readUtf8File(reportPath)) as CompileReport;
  if (!parsed.container) {
    throw new SpawnfileError(
      "validation_error",
      `Compile report at ${reportPath} has no container section; nothing to export.`
    );
  }
  return parsed;
};

const hostPathFor = (destinationDirectory: string, relativePath: string): string =>
  path.join(destinationDirectory, ...relativePath.split("/"));

const exportOnePlannedFile = async (input: {
  containerRef: string;
  destinationDirectory: string;
  dockerCommand: string;
  execFile: DockerArtifactExecFile;
  plan: PlannedExportFile;
  readerImage: string;
  target: DeploymentRecord["target"];
  timeoutMs: number;
}): Promise<ExportIndexFile | null> => {
  const hostPath = hostPathFor(input.destinationDirectory, input.plan.relativePath);
  await ensureDirectory(path.dirname(hostPath));

  const runnerOptions = { dockerCommand: input.dockerCommand, execFile: input.execFile, timeoutMs: input.timeoutMs };
  let copied: boolean;
  let source: ExportIndexSource;

  if (input.plan.source.kind === "container") {
    copied = await copyContainerFileToHost({
      containerPath: input.plan.source.containerPath,
      containerRef: input.containerRef,
      hostPath,
      target: input.target,
      ...runnerOptions
    });
    source = { kind: "container", ref: `${input.containerRef}:${input.plan.source.containerPath}` };
  } else {
    copied = await copyVolumeFileToHost({
      hostPath,
      readerImage: input.readerImage,
      target: input.target,
      volumeName: input.plan.source.volumeName,
      volumePath: input.plan.source.volumePath,
      ...runnerOptions
    });
    source = { kind: "volume", ref: `${input.plan.source.volumeName}:/${input.plan.source.volumePath}` };
  }

  if (!copied) {
    // docker cp never creates a partial file on failure, but be defensive: never leave a
    // stray empty file behind for a copy this function considers failed.
    await rm(hostPath, { force: true });
    return null;
  }

  const [copiedPath] = await resolveOutputFilePaths(input.destinationDirectory, [input.plan.relativePath]);
  const buffer = await readFile(copiedPath!);
  return {
    bytes: buffer.byteLength,
    path: input.plan.relativePath,
    sha256: sha256Hex(buffer),
    source
  };
};

/** Export durable volume files after a container stops, or request a live container
 * for adapters that declare container sources or private runtime directories. */
export const exportRunArtifacts = async (
  options: ExportRunArtifactsOptions
): Promise<ExportRunArtifactsResult> => {
  const compiledOutputDirectory = path.resolve(options.compiledOutputDirectory);
  const destinationDirectory = await resolveOutputRoot(path.resolve(options.destinationDirectory));
  const dockerCommand = options.dockerCommand ?? "docker";
  const execFileImpl = options.execFile ?? defaultDockerArtifactExecFile;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const record = await resolveDeploymentRecord(compiledOutputDirectory, options);
  assertDeploymentLifecycleCorrelation(
    record,
    options.expectedLifecycleCorrelation
  );
  const unit = record.units[0];
  if (!unit) {
    throw new SpawnfileError("validation_error", `Deployment "${record.name}" has no recorded container unit`);
  }
  const containerRef = targetRefForUnit(unit);
  if (!containerRef) {
    throw new SpawnfileError(
      "validation_error",
      `Deployment "${record.name}" has no recorded container id or name`
    );
  }

  const runId = record.run_id;
  if (!runId) {
    throw new SpawnfileError(
      "validation_error",
      `Deployment "${record.name}" has no recorded run id (it predates run-id tracking, or was ` +
        "compiled with no NOOPOLIS_RUN_ID set), so a conformant export-index.json cannot be " +
        "written. Recompile and redeploy the project (with NOOPOLIS_RUN_ID set, or via a plain " +
        "`spawnfile up --detach`, which always generates one) before exporting artifacts."
    );
  }

  const report = await readCompileReport(compiledOutputDirectory);
  if (report.compile_fingerprint !== undefined && report.compile_fingerprint !== record.compile_fingerprint) {
    throw new SpawnfileError("validation_error", "The compile report does not match the deployment being exported");
  }
  const planned = planArtifactExports(report);
  const privateDirectories = options.includePrivate ? planPrivateArtifactExports(report) : [];
  const indexPath = path.join(destinationDirectory, EXPORT_INDEX_PATH);
  const readerImage = options.readerImage ?? unit.image_tag;
  await ensureDirectory(destinationDirectory);
  const temporary = await mkdtemp(path.join(destinationDirectory, ".spawnfile-export-"));
  try {
    const stagingDirectory = path.join(temporary, "files");
    await ensureDirectory(stagingDirectory);
    await resolveArtifactOutputPaths(stagingDirectory, [...planned, ...privateDirectories].map((entry) => entry.relativePath));
    if (options.includePrivate || planned.some((entry) => entry.source.kind === "container")) {
      if (!(await containerExists(record.target, containerRef, { dockerCommand, execFile: execFileImpl, timeoutMs }))) {
        throw new SpawnfileError("runtime_error",
          `Deployment "${record.name}" has no live container ("${containerRef}"). Run ` +
          "`spawnfile artifacts export` BEFORE `spawnfile down`, or recompile to use durable volumes.");
      }
    }
    const staged = await stageExport({
      containerRef, dockerCommand, execFile: execFileImpl, privateDirectories,
      planned, readerImage, report, stagingDirectory, target: record.target, timeoutMs
    });
    return await publishExport({
      ...staged, compiledOutputDirectory, destinationDirectory, indexPath, record, runId, stagingDirectory
    });
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
};

const stageExport = async (input: {
  containerRef: string;
  dockerCommand: string;
  execFile: DockerArtifactExecFile;
  privateDirectories: readonly RuntimePrivateExportDirectory[];
  planned: readonly PlannedExportFile[];
  readerImage: string;
  report: CompileReport;
  stagingDirectory: string;
  target: DeploymentRecord["target"];
  timeoutMs: number;
}): Promise<{ failedFiles: string[]; files: ExportIndexFile[]; missingOptionalFiles: string[] }> => {
  const files: ExportIndexFile[] = [];
  const missingOptionalFiles: string[] = [];
  const failedFiles: string[] = [];
  for (const plan of input.planned) {
    const entry = await exportOnePlannedFile({ ...input, destinationDirectory: input.stagingDirectory, plan });
    if (entry) {
      files.push(entry);
    } else if (plan.optional) {
      missingOptionalFiles.push(plan.relativePath);
    } else {
      failedFiles.push(plan.relativePath);
    }
  }
  if (input.privateDirectories.length) {
    const privateResult = await exportPrivateRuntimeArtifacts({
      containerRef: input.containerRef,
      destinationDirectory: input.stagingDirectory,
      dockerCommand: input.dockerCommand,
      execFile: input.execFile,
      report: input.report,
      target: input.target,
      timeoutMs: input.timeoutMs,
    }, input.privateDirectories);
    files.push(...privateResult.files);
    // A requested private directory that cannot be read is a required-file failure.
    failedFiles.push(...privateResult.missing);
  }
  return { failedFiles, files, missingOptionalFiles };
};

const publishExport = async (input: {
  compiledOutputDirectory: string;
  destinationDirectory: string;
  failedFiles: string[];
  files: ExportIndexFile[];
  indexPath: string;
  missingOptionalFiles: string[];
  record: DeploymentRecord;
  runId: string;
  stagingDirectory: string;
}): Promise<ExportRunArtifactsResult> => {
  const { failedFiles, indexPath, missingOptionalFiles, record, runId } = input;
  const index: ExportIndex = {
    deployment: record.name,
    exported_at: new Date().toISOString(),
    files: input.files.sort((left, right) => left.path.localeCompare(right.path)),
    run_id: runId,
    version: EXPORT_INDEX_VERSION
  };

  // A required file that failed to copy is not a successful export: leave the
  // destination, its index and the deployment record exactly as they were.
  if (failedFiles.length > 0) {
    return { deploymentName: record.name, failedFiles, index, indexPath, missingOptionalFiles };
  }
  await writeDeploymentRecord(input.compiledOutputDirectory, {
    ...record,
    export_index: { exported_at: index.exported_at, path: indexPath, run_id: runId }
  }, record, () => publishArtifactFiles(input.destinationDirectory, input.stagingDirectory, index));

  return {
    deploymentName: record.name,
    failedFiles,
    index,
    indexPath,
    missingOptionalFiles
  };
};
