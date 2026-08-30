import path from "node:path";

import { fileExists, readUtf8File } from "../filesystem/index.js";
import { derivePersistentMountVolumeName, parseDistributionReport } from "../distribution/index.js";
import type { CompileReport } from "../report/index.js";
import { REPORT_FILENAME, SpawnfileError } from "../shared/index.js";

import { exportRunArtifacts } from "./artifactsExport.js";
import {
  assertDeploymentLifecycleCorrelation,
  type DeploymentLifecycleCorrelation,
} from "./deploymentLifecycleCorrelation.js";
import {
  defaultDockerTeardownExecFile,
  removeDockerContainer,
  removeDockerVolume,
  type DockerTeardownExecFile,
} from "./dockerTeardown.js";
import { DOWN_RECEIPT_VERSION, type DownReceipt } from "./downReceiptTypes.js";
import {
  initializeOrganizationHandoffAuthorityStore,
  type OrganizationHandoffAuthorityStore,
} from "./organizationHandoffAuthorityStore.js";
import { readDeploymentRecordFromOutput } from "./record.js";
import type { DeploymentRecord } from "./record.js";
import { readHomeDeploymentRecord, readHomeDeploymentReport, resolveHomeRecordPath } from "./homeStore.js";
import { resolveDeploymentRecordPath } from "./names.js";
import { dockerContextNameForTarget } from "./target.js";

export interface DownDeploymentOptions {
  /** Where the deployment record + compile report already live (the compile's own
   * `--out` directory) — same convention as `exportRunArtifacts`'s `compiledOutputDirectory`. */
  compiledOutputDirectory: string;
  deploymentName: string;
  dockerCommand?: string;
  execFile?: DockerTeardownExecFile;
  /** Auto-runs `spawnfile artifacts export` to this directory before tearing down, when
   * this run has no export-index yet. Mutually satisfying with `force` — either one
   * clears the export-before-teardown guard, `exportTo` by doing the export, `force` by
   * deliberately skipping it. */
  exportTo?: string;
  /** Deliberately discards un-exported artifacts and proceeds without exporting. */
  force?: boolean;
  readerImage?: string;
  /** Also removes this deployment's named volumes. Default: retain (see CLAUDE.md's
   * folder rule — this is the only reversible-by-default lifecycle boundary spawnfile
   * has: containers are cheap to recreate, the durable stores are not). */
  removeVolumes?: boolean;
  expectedLifecycleCorrelation?: DeploymentLifecycleCorrelation;
  timeoutMs?: number;
}

export const readCanonicalDownRecord = async (
  compiledOutputDirectory: string,
  deploymentName: string
): Promise<{ mode: "image" | "project"; record: DeploymentRecord }> => {
  const projectPath = resolveDeploymentRecordPath(path.resolve(compiledOutputDirectory), deploymentName);
  const homePath = resolveHomeRecordPath(deploymentName);
  const [projectExists, homeExists] = await Promise.all([fileExists(projectPath), fileExists(homePath)]);
  if (projectExists && homeExists) throw new SpawnfileError("runtime_error", "Deployment record is ambiguous between project and image stores");
  if (projectExists) {
    const record = await readDeploymentRecordFromOutput(path.resolve(compiledOutputDirectory), deploymentName);
    if (record.source.kind !== "project") throw new SpawnfileError("runtime_error", "Project deployment store contains a non-project record");
    return { mode: "project", record };
  }
  if (homeExists) {
    const record = await readHomeDeploymentRecord(deploymentName);
    if (record.source.kind !== "image") throw new SpawnfileError("runtime_error", "Image deployment store contains a non-image record");
    return { mode: "image", record };
  }
  throw new SpawnfileError("validation_error", `No recorded deployment named ${deploymentName}`);
};

const imageDown = async (
  record: DeploymentRecord,
  options: DownDeploymentOptions,
  runner: { dockerCommand: string; execFile: DockerTeardownExecFile; timeoutMs: number }
): Promise<DownReceipt> => {
  if (record.source.kind !== "image" || record.units.length !== 1) throw new SpawnfileError("runtime_error", "Image deployment record is invalid for teardown");
  if (!record.export_index && !options.force) throw new SpawnfileError("runtime_error", "Image deployment artifact export is unsupported; pass --force to discard unexported artifacts");
  const unit = record.units[0]!;
  if (!unit.container_id || !unit.image_id) throw new SpawnfileError("runtime_error", "Image deployment has no exact recorded container or image identity");
  const context = dockerContextNameForTarget(record.target);
  const prefix = context ? ["--context", context] : record.target.kind === "host" ? ["--host", record.target.value] : [];
  const inspected = await runner.execFile(runner.dockerCommand, [...prefix, "container", "inspect", "--format", "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}", unit.container_id], { timeout: runner.timeoutMs });
  let identity: { id: string; imageId: string; labels: Record<string, string>; name: string };
  try {
    const [idLine, nameLine, imageLine, labelsLine, ...extra] = inspected.stdout.trim().split("\n");
    if (!idLine || !nameLine || !imageLine || !labelsLine || extra.length) throw new Error();
    identity = { id: JSON.parse(idLine), imageId: JSON.parse(imageLine), name: JSON.parse(nameLine), labels: JSON.parse(labelsLine) };
  } catch { throw new SpawnfileError("runtime_error", "Image deployment container identity is malformed"); }
  if (identity.id !== unit.container_id || identity.name !== `/${unit.container_name}` || identity.imageId !== unit.image_id
    || identity.labels["com.spawnfile.deployment"] !== record.name
    || identity.labels["com.spawnfile.compile_fingerprint"] !== record.compile_fingerprint
    || identity.labels["com.spawnfile.unit"] !== unit.id) {
    throw new SpawnfileError("runtime_error", "Image deployment container identity does not match its record");
  }
  let reportValue: unknown;
  try {
    reportValue = JSON.parse(await readHomeDeploymentReport(record.name));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError("runtime_error", `Cached image distribution report is unreadable: ${reason}`);
  }
  const report = parseDistributionReport(reportValue, "cached image distribution report");
  if (report.compile_fingerprint !== record.compile_fingerprint) throw new SpawnfileError("runtime_error", "Cached image distribution report does not match its deployment record");
  const volumes = [...new Set(report.persistent_mounts.map((mount) => derivePersistentMountVolumeName(record.name, mount)))].sort();
  const removed = await removeDockerContainer(record.target, unit.container_id, runner);
  if (!removed.removed) return { deployment: record.name, errors: [`unable to remove container ${unit.container_id} (unit ${unit.id}): ${removed.error}`], retained_volumes: volumes, units_stopped: [], version: DOWN_RECEIPT_VERSION };
  const errors: string[] = [], retained: string[] = [];
  if (options.removeVolumes) for (const volume of volumes) { const result = await removeDockerVolume(record.target, volume, runner); if (!result.removed) { errors.push(`unable to remove volume ${volume}: ${result.error}`); retained.push(volume); } }
  else retained.push(...volumes);
  return { deployment: record.name, errors, retained_volumes: retained, units_stopped: [unit.id], version: DOWN_RECEIPT_VERSION };
};

const targetRefForUnit = (
  unit: DeploymentRecord["units"][number],
): string | null => unit.container_id ?? unit.container_name;

const readCompileReport = async (
  compiledOutputDirectory: string,
): Promise<CompileReport | null> => {
  const reportPath = path.join(compiledOutputDirectory, REPORT_FILENAME);
  if (!(await fileExists(reportPath))) {
    return null;
  }
  return JSON.parse(await readUtf8File(reportPath)) as CompileReport;
};

const explainRefusal = (deploymentName: string): string =>
  `Deployment "${deploymentName}" has no export-index: its durable artifacts (moltnet ` +
  "causal log, mneme bank ledgers, daimon telemetry) have not been exported yet, and " +
  "`spawnfile down` would destroy the container they live in before anyone reads them. " +
  `Run \`spawnfile artifacts export --deployment ${deploymentName} --out <dir>\` first, ` +
  "or pass `--export-to <dir>` to export-then-down in one call, or `--force` to " +
  "deliberately discard the un-exported artifacts.";

/** Enforces the export-before-teardown invariant (Decision 21): resolves whether this
 * deployment's record already carries an `export_index` marker (stamped by
 * `exportRunArtifacts` — see record.ts), and if not, either refuses, auto-exports, or
 * (with `--force`) proceeds anyway. Returns the record `spawnfile down` should act on —
 * re-read after an auto-export, since that call updates the record on disk. */
const ensureExported = async (
  record: DeploymentRecord,
  options: DownDeploymentOptions,
): Promise<DeploymentRecord> => {
  if (record.export_index || options.force) {
    return record;
  }
  const exportTo = options.exportTo;
  if (!exportTo) {
    throw new SpawnfileError(
      "runtime_error",
      explainRefusal(options.deploymentName),
    );
  }

  await exportRunArtifacts({
    compiledOutputDirectory: options.compiledOutputDirectory,
    deploymentName: options.deploymentName,
    destinationDirectory: exportTo,
    dockerCommand: options.dockerCommand,
    // Structurally identical exec-call shape as DockerArtifactExecFile (see
    // artifactsExportDocker.ts) — forwarded so an injected fake/override execFile covers
    // the auto-export step too, not just container/volume removal.
    execFile: options.execFile,
    readerImage: options.readerImage,
    timeoutMs: options.timeoutMs,
  });
  return readDeploymentRecordFromOutput(
    options.compiledOutputDirectory,
    options.deploymentName,
  );
};

const closeOrganizationHandoff = async (
  record: DeploymentRecord,
): Promise<void> => {
  const hasPublicHandoff = record.organization_handoff !== undefined;
  const hasPrivateHandle = record.organization_handoff_handle !== undefined;
  if (hasPublicHandoff !== hasPrivateHandle) {
    throw new SpawnfileError(
      "runtime_error",
      "Deployment organization handoff authority is incomplete; refusing teardown",
    );
  }
  if (
    !hasPrivateHandle ||
    record.organization_handoff === undefined ||
    record.organization_handoff_handle === undefined
  )
    return;

  let authority: OrganizationHandoffAuthorityStore | undefined;
  let failed = false;
  try {
    authority = await initializeOrganizationHandoffAuthorityStore();
    await authority.close({
      expectedHandoff: record.organization_handoff,
      organizationHandoffHandle: record.organization_handoff_handle,
    });
  } catch {
    failed = true;
  } finally {
    try {
      await authority?.dispose();
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new SpawnfileError(
      "runtime_error",
      "Unable to close organization handoff authority before deployment teardown",
    );
  }
};

/**
 * `spawnfile down` — record-driven teardown: resolves the deployment record, enforces the
 * export-before-teardown invariant, `docker rm -f`s every recorded container unit, and
 * (only with `--volumes`) removes named volumes. Always returns a `spawnfile.down-
 * receipt.v1`, even when some units/volumes failed to remove (`errors` carries the
 * per-item failures; a partial failure is never silently swallowed, but it also never
 * stops the rest of the teardown from being attempted).
 */
export const downDeployment = async (
  options: DownDeploymentOptions,
): Promise<DownReceipt> => {
  const compiledOutputDirectory = path.resolve(options.compiledOutputDirectory);
  const dockerCommand = options.dockerCommand ?? "docker";
  const execFileImpl = options.execFile ?? defaultDockerTeardownExecFile;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const resolved = await readCanonicalDownRecord(compiledOutputDirectory, options.deploymentName);
  const initialRecord = resolved.record;
  assertDeploymentLifecycleCorrelation(
    initialRecord,
    options.expectedLifecycleCorrelation,
  );
  const runnerOptions = { dockerCommand, execFile: execFileImpl, timeoutMs };
  if (resolved.mode === "image") return imageDown(initialRecord, options, runnerOptions);
  const record = await ensureExported(initialRecord, {
    ...options,
    compiledOutputDirectory,
  });
  assertDeploymentLifecycleCorrelation(
    record,
    options.expectedLifecycleCorrelation,
  );
  await closeOrganizationHandoff(record);

  const unitsStopped: string[] = [];
  const errors: string[] = [];

  for (const unit of record.units) {
    const containerRef = targetRefForUnit(unit);
    if (!containerRef) {
      errors.push(
        `unit ${unit.id} has no recorded container id or name; nothing to remove`,
      );
      continue;
    }
    const outcome = await removeDockerContainer(
      record.target,
      containerRef,
      runnerOptions,
    );
    if (outcome.removed) {
      unitsStopped.push(unit.id);
    } else {
      errors.push(
        `unable to remove container ${containerRef} (unit ${unit.id}): ${outcome.error}`,
      );
    }
  }

  const report = await readCompileReport(compiledOutputDirectory);
  const volumeNames = [
    ...new Set(
      (report?.container?.persistent_mounts ?? []).map(
        (mount) => mount.volume_name,
      ),
    ),
  ].sort();

  const retainedVolumes: string[] = [];
  if (options.removeVolumes) {
    for (const volumeName of volumeNames) {
      const outcome = await removeDockerVolume(
        record.target,
        volumeName,
        runnerOptions,
      );
      if (!outcome.removed) {
        errors.push(`unable to remove volume ${volumeName}: ${outcome.error}`);
        retainedVolumes.push(volumeName);
      }
    }
  } else {
    retainedVolumes.push(...volumeNames);
  }

  return {
    deployment: record.name,
    errors,
    retained_volumes: retainedVolumes.sort(),
    units_stopped: unitsStopped.sort(),
    version: DOWN_RECEIPT_VERSION,
  };
};
