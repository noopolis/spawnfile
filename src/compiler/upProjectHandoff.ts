import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  createDockerOrganizationHandoffSession,
  initializeOrganizationHandoffAuthorityStore,
  parseCanonicalSha256Digest,
  type DockerTargetExecFile,
  type OrganizationHandoffInput,
} from "../deployment/index.js";
import {
  createCanonicalSelectedTargetReceiptBytes,
  parseOpaqueTargetHandle,
  parseRunId,
  parseSelectedTargetReceipt,
  selectTarget,
  type OpaqueTargetHandle,
  type SelectedTargetReceipt,
} from "../target/index.js";
import type { UpLifecycleRecovery } from "../deployment/upLifecycleRecoveryState.js";
import { isTrustedUpLifecycleRecovery } from "../deployment/upLifecycleRecoveryState.js";
import { SpawnfileError } from "../shared/index.js";

import type { BuildProjectResult } from "./buildProject.js";
import { executeDockerRunWithSupportCleanup } from "./runProjectLifecycle.js";
import {
  recoverDetachedDockerRun,
  type DockerRunInvocation,
  type DockerRunResult,
  type DockerRunRunner,
} from "./runProject.js";

export interface OrganizationHandoffRequestOptions {
  readonly descriptorDigest?: string;
  readonly detach?: boolean;
  readonly networkAttachmentHandle?: string;
  readonly organizationHandoffRunId?: string;
  readonly selectedTargetReceipt?: unknown;
  readonly selectedTargetReceiptDigest?: string;
  readonly worldBindingsPath?: string;
}

export interface RequestedOrganizationHandoff extends Omit<OrganizationHandoffInput, "bindingDigest"> {
  readonly descriptorDigest: string;
  readonly runId: string;
  readonly selectedTarget: SelectedTargetReceipt;
}

export interface CompiledOrganizationHandoff {
  readonly authority: RequestedOrganizationHandoff & { readonly bindingDigest: string };
  readonly organizationHandoff: OrganizationHandoffInput;
}

export interface DetachedReservation {
  readonly containerName: string;
  readonly deploymentLabels: Readonly<Record<string, string>>;
  readonly dockerCommand: string;
  readonly dockerContext: string | null;
}

export const organizationHandoffInputError = (): SpawnfileError =>
  new SpawnfileError(
    "validation_error",
    "Organization handoff requires authorized run id, selected target receipt, descriptor digest, selected target receipt digest, network attachment handle, and world bindings",
  );

const recoveryError = (): SpawnfileError => new SpawnfileError(
  "runtime_error",
  "Organization handoff recovery is incomplete; redeploy with explicit authorization",
);

export const resolveRequestedOrganizationHandoff = (
  options: OrganizationHandoffRequestOptions,
): RequestedOrganizationHandoff | null => {
  const values = [
    options.descriptorDigest,
    options.organizationHandoffRunId,
    options.selectedTargetReceiptDigest,
    options.selectedTargetReceipt,
    options.networkAttachmentHandle,
    options.worldBindingsPath,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined) || !options.detach) throw organizationHandoffInputError();
  try {
    const selectedTarget = parseSelectedTargetReceipt(options.selectedTargetReceipt);
    const selectedDigest = parseCanonicalSha256Digest(options.selectedTargetReceiptDigest, "selected_target_receipt_digest");
    const computedDigest = `sha256:${createHash("sha256").update(
      createCanonicalSelectedTargetReceiptBytes(selectedTarget), "utf8",
    ).digest("hex")}`;
    if (selectedDigest !== computedDigest) throw new Error("selected receipt digest mismatch");
    return {
      descriptorDigest: parseCanonicalSha256Digest(options.descriptorDigest, "descriptor_digest"),
      runId: parseRunId(options.organizationHandoffRunId),
      networkAttachmentHandle: parseOpaqueTargetHandle(options.networkAttachmentHandle),
      selectedTarget,
      selectedTargetReceiptDigest: selectedDigest,
    };
  } catch {
    throw organizationHandoffInputError();
  }
};

export const verifyRequestedOrganizationHandoffTarget = async (
  requested: RequestedOrganizationHandoff | null,
  resolved: { readonly dockerContext?: string | null; readonly dockerHost?: string | null },
  options: Pick<OrganizationHandoffExecutionOptions, "dockerCommand" | "targetExecFile">,
): Promise<void> => {
  if (!requested) return;
  if (typeof resolved.dockerContext !== "string" || resolved.dockerContext.length === 0
    || resolved.dockerHost != null || process.env.DOCKER_HOST != null) throw organizationHandoffInputError();
  try {
    const actual = await selectTarget({
      context: resolved.dockerContext,
      dockerCommand: options.dockerCommand,
      execFile: options.targetExecFile,
    });
    if (createCanonicalSelectedTargetReceiptBytes(actual)
      !== createCanonicalSelectedTargetReceiptBytes(requested.selectedTarget)) throw new Error("target mismatch");
  } catch {
    throw organizationHandoffInputError();
  }
};

export const compileOrganizationHandoff = (
  requested: RequestedOrganizationHandoff | null,
  buildResult: BuildProjectResult,
): CompiledOrganizationHandoff | undefined => {
  if (!requested) return undefined;
  try {
    const bindingDigest = buildResult.organizationReadinessEvidence.worldBindings?.digest;
    if (!bindingDigest) throw new Error("missing compiled binding evidence");
    const parsedBindingDigest = parseCanonicalSha256Digest(bindingDigest, "binding_digest");
    return {
      authority: { ...requested, bindingDigest: parsedBindingDigest },
      organizationHandoff: {
        bindingDigest: parsedBindingDigest,
        networkAttachmentHandle: requested.networkAttachmentHandle,
        selectedTargetReceiptDigest: requested.selectedTargetReceiptDigest,
      },
    };
  } catch {
    throw organizationHandoffInputError();
  }
};

interface OrganizationHandoffExecutionOptions {
  readonly dockerCommand?: string;
  readonly lifecycleRecovery?: UpLifecycleRecovery;
  readonly targetExecFile?: DockerTargetExecFile;
}

export interface ExecuteOrganizationHandoffOptions extends OrganizationHandoffExecutionOptions {
  readonly handoff: CompiledOrganizationHandoff;
  readonly invocation: DockerRunInvocation;
  readonly onDetachedReservation?: (authority: DetachedReservation) => Promise<void>;
  readonly runRunner: DockerRunRunner;
}

interface ExactRunMetadata extends DockerRunResult {
  readonly containerId: string;
  readonly containerName: string;
  readonly deploymentLabels: Readonly<Record<string, string>>;
  readonly imageId: string;
}

const canonical = (value: unknown): string => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const exactRunMetadata = (value: DockerRunResult | void): ExactRunMetadata => {
  if (!value?.containerId || !value.containerName || !value.imageId || !value.deploymentLabels) {
    throw organizationHandoffInputError();
  }
  return value as ExactRunMetadata;
};

const reattestRecoveredRun = async (
  invocation: DockerRunInvocation,
  expected: ExactRunMetadata,
): Promise<ExactRunMetadata> => {
  const actual = exactRunMetadata(await recoverDetachedDockerRun(invocation, expected.containerId));
  if (actual.containerName !== expected.containerName || actual.imageId !== expected.imageId
    || !same(actual.deploymentLabels, expected.deploymentLabels)) throw recoveryError();
  return actual;
};

const recovery = (value: UpLifecycleRecovery | undefined): UpLifecycleRecovery | undefined => {
  if (value !== undefined && !isTrustedUpLifecycleRecovery(value)) throw organizationHandoffInputError();
  return value;
};

const reserveDetachedRun = async (
  invocation: DockerRunInvocation,
  reserve: ExecuteOrganizationHandoffOptions["onDetachedReservation"],
): Promise<void> => {
  if (!reserve) return;
  if (!invocation.detach || !invocation.containerName || !invocation.deploymentLabels) {
    throw new SpawnfileError("runtime_error", "Detached deployment authority is incomplete");
  }
  await reserve({
    containerName: invocation.containerName,
    deploymentLabels: invocation.deploymentLabels,
    dockerCommand: invocation.command,
    dockerContext: invocation.dockerContext ?? null,
  });
};

/** Resumes only lifecycle-verified state, never stale authority observations. */
export const executeOrganizationHandoff = async (
  input: ExecuteOrganizationHandoffOptions,
): Promise<{ readonly organizationHandoffHandle: OpaqueTargetHandle; readonly runMetadata: ExactRunMetadata }> => {
  const { handoff, invocation } = input;
  if (!invocation.deploymentLabels || !invocation.containerName) throw organizationHandoffInputError();
  const lifecycleRecovery = recovery(input.lifecycleRecovery);
  const session = createDockerOrganizationHandoffSession({
    bindingDigest: handoff.authority.bindingDigest,
    containerName: invocation.containerName,
    deploymentLabels: invocation.deploymentLabels,
    descriptorDigest: handoff.authority.descriptorDigest,
    organizationHandoff: handoff.organizationHandoff,
    runId: handoff.authority.runId,
    selectedTarget: handoff.authority.selectedTarget,
    selectedTargetReceiptDigest: handoff.authority.selectedTargetReceiptDigest,
  });
  let authority: Awaited<ReturnType<typeof initializeOrganizationHandoffAuthorityStore>> | undefined;
  let dockerLifecycleInvoked = false;
  try {
    // Persist the lifecycle reservation first. A post-begin crash can then be
    // distinguished as no-start, exact-container, or ambiguous on restart.
    if (lifecycleRecovery?.kind !== "deployment_record") {
      await reserveDetachedRun(invocation, input.onDetachedReservation);
    }
    authority = await initializeOrganizationHandoffAuthorityStore();
    const begun = await authority.begin(session.authorityInput);
    let runMetadata: ExactRunMetadata;
    if (begun.created) {
      if (lifecycleRecovery?.kind === "detached_container"
        || lifecycleRecovery?.kind === "deployment_record") throw recoveryError();
      dockerLifecycleInvoked = true;
      runMetadata = exactRunMetadata(await executeDockerRunWithSupportCleanup(invocation, input.runRunner));
    } else {
      const observed = await authority.readDockerMutation(begun.pending.pending_key);
      if (observed) {
        if (lifecycleRecovery?.kind === "no_docker_mutation") throw recoveryError();
        const expected: ExactRunMetadata = {
          containerId: observed.container_id,
          containerName: invocation.containerName,
          deploymentLabels: observed.deployment_labels,
          imageId: observed.image_id,
        };
        if (lifecycleRecovery?.kind === "detached_container" && (
          lifecycleRecovery.containerId !== expected.containerId
          || lifecycleRecovery.containerName !== expected.containerName
          || lifecycleRecovery.imageId !== expected.imageId
          || !same(lifecycleRecovery.deploymentLabels, expected.deploymentLabels)
        )) throw recoveryError();
        runMetadata = await reattestRecoveredRun(invocation, expected);
      } else if (lifecycleRecovery?.kind === "detached_container") {
        runMetadata = await reattestRecoveredRun(invocation, lifecycleRecovery);
      } else if (lifecycleRecovery?.kind === "no_docker_mutation") {
        dockerLifecycleInvoked = true;
        runMetadata = exactRunMetadata(await executeDockerRunWithSupportCleanup(invocation, input.runRunner));
      } else throw recoveryError();
    }
    await authority.observeDockerMutation(begun.pending.pending_key, runMetadata);
    const finalized = await authority.finalize(begun.pending.pending_key, runMetadata);
    return { organizationHandoffHandle: finalized.organization_handoff_handle, runMetadata };
  } finally {
    let cleanupError: unknown;
    try {
      if (invocation.detach && !dockerLifecycleInvoked) await rm(invocation.envFilePath, { force: true });
    } catch (error) {
      cleanupError = error;
    }
    try {
      await authority?.dispose();
    } catch (error) {
      if (cleanupError === undefined) throw error;
    }
    if (cleanupError !== undefined) throw cleanupError;
  }
};
