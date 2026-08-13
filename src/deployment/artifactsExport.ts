import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";

import { ensureDirectory, fileExists, readUtf8File, writeUtf8File } from "../filesystem/index.js";
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
import { exportPrivateRuntimeArtifacts } from "./privateArtifactsExport.js";
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
   * (a real per-file problem, worth surfacing — as opposed to `missingOptionalFiles`). */
  failedFiles: string[];
  index: ExportIndex;
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

  const buffer = await readFile(hostPath);
  return {
    bytes: buffer.byteLength,
    path: input.plan.relativePath,
    sha256: sha256Hex(buffer),
    source
  };
};

/**
 * `spawnfile artifacts export` — mechanical egress of a run's durable artifacts (moltnet
 * causal log, mneme bank ledgers, daimon per-agent telemetry) into the compose-and-observe
 * run-dir layout (`decisions.md` Decision 21 §2), plus the `spawnfile.export-index.v1`
 * index simfile's observer folds into its own run manifest.
 *
 * As of Piece 4b, every planned file is volume-sourced (moltnet + mneme already were;
 * daimon telemetry joined them — see `artifactsExportPlan.ts`'s `planDaimonFiles`), and a
 * named volume outlives its container across a plain `docker rm` (no `--volumes`). So this
 * no longer requires the deployment's container to still be alive in the general case: the
 * container-liveness check below (`requiresLiveContainer`) only runs when the plan actually
 * contains a `kind: "container"` file, which today only happens for a legacy pre-Piece-4b
 * compile report. This is the real relaxation of the export-before-teardown invariant
 * Piece 4b unlocks: `spawnfile down` (without `--volumes`) can run BEFORE `spawnfile
 * artifacts export`, and export still recovers everything from the named volumes.
 */
export const exportRunArtifacts = async (
  options: ExportRunArtifactsOptions
): Promise<ExportRunArtifactsResult> => {
  const compiledOutputDirectory = path.resolve(options.compiledOutputDirectory);
  const destinationDirectory = path.resolve(options.destinationDirectory);
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
  const planned = planArtifactExports(report);

  // Only a `kind: "container"` planned file needs the live container (see this function's
  // own doc comment) — every other source reads a named volume, which survives a plain
  // `docker rm` on its own. Gating on this, rather than checking unconditionally, is the
  // actual export-before-teardown relaxation Piece 4b delivers.
  const requiresLiveContainer = options.includePrivate === true
    || planned.some((entry) => entry.source.kind === "container");
  if (requiresLiveContainer) {
    const exists = await containerExists(record.target, containerRef, {
      dockerCommand,
      execFile: execFileImpl,
      timeoutMs
    });
    if (!exists) {
      throw new SpawnfileError(
        "runtime_error",
        `Deployment "${record.name}" has no live container ("${containerRef}"), and its planned export ` +
          "includes at least one file that can only be read from a live container (a legacy, " +
          "pre-Piece-4b compile report — recompile to move it onto a durable volume). Run " +
          "`spawnfile artifacts export` BEFORE `spawnfile down` removes the container, or recompile."
      );
    }
  }

  const readerImage = options.readerImage ?? unit.image_tag;

  const files: ExportIndexFile[] = [];
  const missingOptionalFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const plan of planned) {
    const entry = await exportOnePlannedFile({
      containerRef,
      destinationDirectory,
      dockerCommand,
      execFile: execFileImpl,
      plan,
      readerImage,
      target: record.target,
      timeoutMs
    });
    if (entry) {
      files.push(entry);
    } else if (plan.optional) {
      missingOptionalFiles.push(plan.relativePath);
    } else {
      failedFiles.push(plan.relativePath);
    }
  }
  if (options.includePrivate === true) {
    const privateResult = await exportPrivateRuntimeArtifacts({
      containerRef,
      destinationDirectory,
      dockerCommand,
      execFile: execFileImpl,
      report,
      target: record.target,
      timeoutMs,
    });
    files.push(...privateResult.files);
    failedFiles.push(...privateResult.missing);
  }

  const index: ExportIndex = {
    deployment: record.name,
    exported_at: new Date().toISOString(),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    run_id: runId,
    version: EXPORT_INDEX_VERSION
  };

  const indexPath = path.join(destinationDirectory, "spawnfile", "export-index.json");
  await ensureDirectory(path.dirname(indexPath));
  await writeUtf8File(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  // Stamp the export-before-teardown marker onto the SAME deployment record `spawnfile
  // down` resolves (record.ts's `export_index`), so down never needs a second, out-of-band
  // way to learn that this run's artifacts are already safe to discard the container for.
  await writeDeploymentRecord(compiledOutputDirectory, {
    ...record,
    export_index: { exported_at: index.exported_at, path: indexPath, run_id: runId }
  });

  return {
    deploymentName: record.name,
    failedFiles,
    index,
    indexPath,
    missingOptionalFiles
  };
};
