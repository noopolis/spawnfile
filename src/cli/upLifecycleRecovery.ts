import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  createDeploymentInstanceDigest,
  findLifecycleOutcomeEvidence,
  findLifecycleUpReservation,
  findLifecycleUpStart,
  readDeploymentRecord,
  recordLifecycleUpStart,
  resolveDeploymentRecordPath,
  type LifecycleOwnerCapability,
  type LifecycleUpReservation,
  type LifecycleUpStartState,
} from "../deployment/index.js";
import {
  deploymentRecordRecovery,
  detachedContainerRecovery,
  noDockerMutationRecovery,
} from "../deployment/upLifecycleRecoveryState.js";
import { readUtf8File, resolveProjectOutputDirectory } from "../filesystem/index.js";
import type { CompileReport } from "../report/index.js";
import { DEFAULT_OUTPUT_DIRECTORY, REPORT_FILENAME } from "../shared/index.js";

import type { LifecycleReconciliation } from "./lifecycleMachine.js";
import type { UpLifecycleOptions } from "./upLifecycleInvocation.js";

const execFile = promisify(execFileCallback);
const inspectFormat = "{{json .Id}}\n{{json .Name}}\n{{json .Image}}\n{{json .Config.Labels}}";
const imageFormat = "{{json .Id}}\n{{json .Config.Labels}}";

const ambiguous = (reason: string): LifecycleReconciliation => ({ reason, status: "ambiguous" });
const canonical = (value: unknown): string => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const isRecord = (value: unknown): value is Record<string, string> => value !== null
  && typeof value === "object" && !Array.isArray(value)
  && Object.values(value).every((entry) => typeof entry === "string");

const exactHandoff = (
  record: Awaited<ReturnType<typeof readDeploymentRecord>>,
  options: UpLifecycleOptions,
): boolean => record.organization_handoff !== undefined
  && record.organization_handoff_handle !== undefined
  && record.organization_handoff.network_attachment_handle === options.networkAttachmentHandle
  && record.organization_handoff.selected_target_receipt_digest === options.selectedTargetReceiptDigest;

const exactNoSuchContainer = (error: unknown): boolean =>
  /(?:No such container|No such object)/u.test(error instanceof Error ? error.message : String(error));
const missingDeploymentRecord = async (recordPath: string): Promise<boolean> => {
  try {
    await lstat(recordPath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};
const dockerArgs = (reservation: LifecycleUpReservation, args: string[]): string[] => [
  ...(reservation.docker_context ? ["--context", reservation.docker_context] : []), ...args,
];
const reservationMatchesRequest = (
  reservation: LifecycleUpReservation,
  options: UpLifecycleOptions,
): boolean => reservation.docker_context === (options.context ?? null)
  && reservation.docker_command === (options.dockerCommand ?? "docker");

interface ObservedContainer {
  readonly container_id: string;
  readonly container_name: string;
  readonly image_id: string;
  readonly labels: Record<string, string>;
}

const inspectContainer = async (
  reservation: LifecycleUpReservation,
  reference: string,
): Promise<ObservedContainer | null> => {
  try {
    const result = await execFile(reservation.docker_command, dockerArgs(reservation, [
      "container", "inspect", "--format", inspectFormat, reference,
    ]), { timeout: 10_000 });
    const [id, name, image, labels, ...extra] = result.stdout.trim().split("\n");
    const containerId = id ? JSON.parse(id) : undefined;
    const containerName = name ? JSON.parse(name) : undefined;
    const imageId = image ? JSON.parse(image) : undefined;
    const parsedLabels = labels ? JSON.parse(labels) : undefined;
    if (extra.length || typeof containerId !== "string" || !/^[a-f0-9]{64}$/u.test(containerId)
      || typeof containerName !== "string" || !containerName.startsWith("/") || containerName.length < 2
      || typeof imageId !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(imageId) || !isRecord(parsedLabels)) throw new Error("invalid inspect");
    return { container_id: containerId, container_name: containerName.slice(1), image_id: imageId, labels: parsedLabels };
  } catch (error) {
    if (exactNoSuchContainer(error)) return null;
    throw error;
  }
};

const verifyImageLabels = async (
  reservation: LifecycleUpReservation,
  observed: ObservedContainer,
): Promise<boolean> => {
  const result = await execFile(reservation.docker_command, dockerArgs(reservation, [
    "image", "inspect", "--format", imageFormat, observed.image_id,
  ]), { timeout: 10_000 });
  const [id, labels, ...extra] = result.stdout.trim().split("\n");
  const imageId = id ? JSON.parse(id) : undefined;
  const parsedLabels = labels ? JSON.parse(labels) : {};
  const imageLabels = parsedLabels === null ? {} : parsedLabels;
  if (extra.length || imageId !== observed.image_id || !isRecord(imageLabels)) return false;
  const required = reservation.label_authority.required;
  const expected = { ...imageLabels, ...required };
  return canonical(observed.labels) === canonical(expected);
};

const verifyObserved = async (
  reservation: LifecycleUpReservation,
  observed: ObservedContainer | null,
  expectedId?: string,
  expectedImageId?: string,
): Promise<boolean> => observed !== null
  && observed.container_name === reservation.container_name
  && (expectedId === undefined || observed.container_id === expectedId)
  && (expectedImageId === undefined || observed.image_id === expectedImageId)
  && await verifyImageLabels(reservation, observed);

const recoverRecordedDetachedContainer = async (
  reservation: LifecycleUpReservation,
  state: LifecycleUpStartState,
): Promise<LifecycleReconciliation> => {
  const start = state.start;
  if (start.container_name !== reservation.container_name
    || canonical(start.label_authority) !== canonical(reservation.label_authority)) {
    return ambiguous("up_started_container_authority_drifted");
  }
  try {
    const observed = await inspectContainer(reservation, start.container_id);
    if (observed === null) return ambiguous("up_started_container_missing");
    if (!await verifyObserved(reservation, observed, start.container_id, start.image_id)) {
      return ambiguous("up_started_container_drifted");
    }
    return {
      recovery: detachedContainerRecovery({
        containerId: observed.container_id,
        containerName: observed.container_name,
        deploymentLabels: reservation.label_authority.required,
        imageId: observed.image_id,
      }),
      status: "resume_safe",
    };
  } catch {
    return ambiguous("up_started_container_reconciliation_failed");
  }
};

const reconcileUnrecordedStart = async (
  invocation: Parameters<typeof findLifecycleOutcomeEvidence>[0],
  options: UpLifecycleOptions,
  capability: LifecycleOwnerCapability,
): Promise<LifecycleReconciliation> => {
  let reservation: LifecycleUpReservation | null;
  try { reservation = await findLifecycleUpReservation(invocation); } catch { return ambiguous("up_reservation_invalid"); }
  // A current implementation performs no Docker effect before publishing this
  // fsynced reservation, so its absence is restart-safe but never called not-applied.
  if (reservation === null) return { status: "resume_safe" };
  if (!reservationMatchesRequest(reservation, options)) return ambiguous("up_reservation_request_drifted");
  try {
    const observed = await inspectContainer(reservation, reservation.container_name);
    if (observed === null) {
      return { recovery: noDockerMutationRecovery(), status: "provably_not_applied" };
    }
    if (!await verifyObserved(reservation, observed)) return ambiguous("up_reserved_container_drifted");
    await recordLifecycleUpStart(invocation, {
      container_id: observed.container_id,
      container_name: observed.container_name,
      image_id: observed.image_id,
      label_authority: reservation.label_authority,
    }, capability);
    return {
      recovery: detachedContainerRecovery({
        containerId: observed.container_id,
        containerName: observed.container_name,
        deploymentLabels: reservation.label_authority.required,
        imageId: observed.image_id,
      }),
      status: "resume_safe",
    };
  } catch { return ambiguous("up_reserved_container_reconciliation_failed"); }
};

export const reconcileUpLifecycle = async (
  inputPath: string,
  options: UpLifecycleOptions,
  invocation: Parameters<typeof findLifecycleOutcomeEvidence>[0],
  capability: LifecycleOwnerCapability,
): Promise<LifecycleReconciliation> => {
  const outputDirectory = resolveProjectOutputDirectory(inputPath, options.out, DEFAULT_OUTPUT_DIRECTORY);
  if (!options.deployment) return ambiguous("up_deployment_not_bound");
  const recordPath = resolveDeploymentRecordPath(outputDirectory, options.deployment);
  if (!await missingDeploymentRecord(recordPath)) {
    let record: Awaited<ReturnType<typeof readDeploymentRecord>>;
    try { record = await readDeploymentRecord(recordPath); } catch {
      return ambiguous("up_durable_evidence_absent_or_invalid");
    }
    try {
      const report = JSON.parse(await readUtf8File(path.join(outputDirectory, REPORT_FILENAME))) as CompileReport;
      if (record.name !== options.deployment || record.output_directory !== outputDirectory
        || record.source.kind !== "project" || path.resolve(record.source.root) !== path.resolve(inputPath)
        || record.compile_fingerprint !== report.compile_fingerprint
        || record.auth_profile !== (options.authProfile ?? null)
        || (options.context !== undefined && (record.target.kind !== "context" || record.target.name !== options.context))
        || (options.name !== undefined && record.units[0]?.container_name !== options.name)
        || !exactHandoff(record, options)) return ambiguous("up_durable_evidence_drifted");
      const evidence = await findLifecycleOutcomeEvidence(invocation);
      if (!evidence) return { recovery: deploymentRecordRecovery(), status: "resume_safe" };
      return evidence.deployment_instance_digest === createDeploymentInstanceDigest(record)
        ? { outcomeBytes: evidence.completion.outcome_bytes, status: "completed" }
        : ambiguous("up_deployment_instance_changed");
    } catch { return ambiguous("up_durable_evidence_absent_or_invalid"); }
  }
  let started: LifecycleUpStartState | null;
  try { started = await findLifecycleUpStart(invocation); } catch {
    return ambiguous("up_start_record_unreadable");
  }
  if (started) {
    const reservation = await findLifecycleUpReservation(invocation).catch(() => null);
    return reservation === null || !reservationMatchesRequest(reservation, options)
      ? ambiguous("up_start_reservation_unavailable")
      : recoverRecordedDetachedContainer(reservation, started);
  }
  return reconcileUnrecordedStart(invocation, options, capability);
};
