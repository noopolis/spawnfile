import { createHash } from "node:crypto";

import {
  assertOrdinaryJsonGraph, createCanonicalSelectedTargetReceiptBytes,
  parseOpaqueTargetHandle, parseRunId, parseSelectedTargetReceipt,
  type OpaqueTargetHandle, type SelectedTargetReceipt
} from "../target/index.js";
import { dockerDeploymentLabelKeys } from "./dockerLabels.js";
import { ORGANIZATION_HANDOFF_AUTHORITY_ERROR } from "./organizationHandoffAuthorityFsBudget.js";
import { parseOrganizationHandoff, type OrganizationHandoff } from "./organizationHandoffTypes.js";

export const ORGANIZATION_HANDOFF_CAPABILITY_VERSION =
  "spawnfile.organization-handoff-capability.private.v1" as const;
export const ORGANIZATION_HANDOFF_RECOVERY_VERSION =
  "spawnfile.organization-handoff-recovery.private.v1" as const;
export { ORGANIZATION_HANDOFF_AUTHORITY_ERROR };

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER = /^[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const labels = Object.values(dockerDeploymentLabelKeys).sort();

export type OrganizationHandoffCapabilityState = "pending" | "finalized" | "attach_closed";
export type OrganizationHandoffDeploymentLabels = Readonly<Record<(typeof labels)[number], string>>;

export interface OrganizationHandoffCapabilityPending {
  readonly binding_digest: string;
  readonly container_name: string;
  readonly deployment_labels: OrganizationHandoffDeploymentLabels;
  readonly descriptor_digest: string;
  readonly handoff: OrganizationHandoff;
  readonly pending_key: string;
  readonly selected_target: SelectedTargetReceipt;
  readonly selected_target_receipt_digest: string;
  readonly state: "pending";
  readonly version: typeof ORGANIZATION_HANDOFF_CAPABILITY_VERSION;
}
export interface OrganizationHandoffCapabilityFinalized extends Omit<OrganizationHandoffCapabilityPending, "state"> {
  readonly container_id: string;
  readonly organization_handoff_handle: OpaqueTargetHandle;
  readonly state: "finalized";
}
export interface OrganizationHandoffCapabilityClosed extends Omit<OrganizationHandoffCapabilityFinalized, "state"> {
  readonly state: "attach_closed";
}
export type OrganizationHandoffCapability = OrganizationHandoffCapabilityPending
  | OrganizationHandoffCapabilityFinalized | OrganizationHandoffCapabilityClosed;

/**
 * A direct, host-local checkpoint made only after Docker returned the exact
 * container id and its inspected deployment labels.  It deliberately does not
 * represent a new capability state: capability authority remains
 * pending -> finalized -> attach_closed.
 */
export interface OrganizationHandoffDockerObservation {
  readonly container_id: string;
  readonly deployment_labels: OrganizationHandoffDeploymentLabels;
  readonly image_id: string;
  readonly pending_key: string;
  readonly version: typeof ORGANIZATION_HANDOFF_RECOVERY_VERSION;
}

const fail = (): never => { throw new Error(ORGANIZATION_HANDOFF_AUTHORITY_ERROR); };
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const digest = (value: unknown): string => typeof value === "string" && DIGEST.test(value) ? value : fail();
const canonicalSelectedDigest = (selected: SelectedTargetReceipt): string =>
  `sha256:${createHash("sha256").update(createCanonicalSelectedTargetReceiptBytes(selected), "utf8").digest("hex")}`;
const exactLabels = (value: unknown): OrganizationHandoffDeploymentLabels => {
  if (!exact(value, labels)) return fail();
  for (const key of labels) if (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value[key])) fail();
  return Object.freeze(Object.fromEntries(labels.map((key) => [key, value[key] as string]))) as OrganizationHandoffDeploymentLabels;
};
const key = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.organization-handoff-authority.${domain}.v1\0`, "utf8").update(value, "utf8").digest("hex");

const pendingKey = (value: unknown): string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : fail();

export const createOrganizationHandoffPendingKey = (input: Omit<OrganizationHandoffCapabilityPending, "pending_key" | "state" | "version">): string =>
  key("reservation", JSON.stringify(input));

/** A domain-separated storage key; never use a raw capability pending key as a leaf name. */
export const createOrganizationHandoffRecoveryKey = (value: unknown): string =>
  key("recovery", pendingKey(value));

export const createOrganizationHandoffDockerObservation = (input: {
  readonly containerId: unknown;
  readonly deploymentLabels: unknown;
  readonly imageId: unknown;
  readonly pendingKey: unknown;
}): OrganizationHandoffDockerObservation => {
  if (typeof input.containerId !== "string" || !CONTAINER.test(input.containerId)
    || typeof input.imageId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.imageId)) return fail();
  return Object.freeze({
    container_id: input.containerId,
    deployment_labels: exactLabels(input.deploymentLabels),
    image_id: input.imageId,
    pending_key: pendingKey(input.pendingKey),
    version: ORGANIZATION_HANDOFF_RECOVERY_VERSION
  });
};

export const parseOrganizationHandoffDockerObservation = (
  raw: unknown
): OrganizationHandoffDockerObservation => {
  try {
    assertOrdinaryJsonGraph(raw);
    if (!exact(raw, ["container_id", "deployment_labels", "image_id", "pending_key", "version"])
      || (raw as Record<string, unknown>).version !== ORGANIZATION_HANDOFF_RECOVERY_VERSION) return fail();
    const value = raw as Record<string, unknown>;
    return createOrganizationHandoffDockerObservation({
      containerId: value.container_id,
      deploymentLabels: value.deployment_labels,
      imageId: value.image_id,
      pendingKey: value.pending_key
    });
  } catch { return fail(); }
};
export const createOrganizationHandoffHandle = (pending: OrganizationHandoffCapabilityPending, containerId: unknown): OpaqueTargetHandle => {
  if (typeof containerId !== "string" || !CONTAINER.test(containerId)) return fail();
  const handle = parseOpaqueTargetHandle(`opaque_${key("capability", JSON.stringify({
    binding_digest: pending.binding_digest, container_id: containerId, container_name: pending.container_name,
    deployment_labels: pending.deployment_labels, descriptor_digest: pending.descriptor_digest,
    handoff: pending.handoff, pending_key: pending.pending_key, selected_target: pending.selected_target,
    selected_target_receipt_digest: pending.selected_target_receipt_digest
  }))}`);
  if (handle === pending.handoff.network_attachment_handle || handle === pending.selected_target.handle) return fail();
  return handle;
};
export const createOrganizationHandoffCapabilityPending = (input: {
  readonly bindingDigest: unknown; readonly containerName: unknown; readonly deploymentLabels: unknown;
  readonly descriptorDigest: unknown; readonly handoff: unknown; readonly selectedTarget: unknown;
  readonly selectedTargetReceiptDigest: unknown;
}): OrganizationHandoffCapabilityPending => {
  const handoff = parseOrganizationHandoff(input.handoff); const selected = parseSelectedTargetReceipt(input.selectedTarget);
  const selectedDigest = digest(input.selectedTargetReceiptDigest);
  if (selectedDigest !== canonicalSelectedDigest(selected) || handoff.selected_target_receipt_digest !== selectedDigest
    || handoff.binding_digest !== digest(input.bindingDigest) || handoff.network_attachment_handle === selected.handle || typeof input.containerName !== "string"
    || !NAME.test(input.containerName)) return fail();
  const body = { binding_digest: handoff.binding_digest, container_name: input.containerName,
    deployment_labels: exactLabels(input.deploymentLabels), descriptor_digest: digest(input.descriptorDigest), handoff,
    selected_target: selected,
    selected_target_receipt_digest: selectedDigest };
  return Object.freeze({ ...body, pending_key: createOrganizationHandoffPendingKey(body), state: "pending",
    version: ORGANIZATION_HANDOFF_CAPABILITY_VERSION });
};
export const parseOrganizationHandoffCapability = (raw: unknown): OrganizationHandoffCapability => {
  try {
    assertOrdinaryJsonGraph(raw); if (!raw || typeof raw !== "object") return fail();
    const record = raw as Record<string, unknown>; const state = record.state;
    const base = ["binding_digest", "container_name", "deployment_labels", "descriptor_digest", "handoff", "pending_key", "selected_target", "selected_target_receipt_digest", "state", "version"];
    const extra = state === "pending" ? [] : ["container_id", "organization_handoff_handle"];
    if (!exact(raw, [...base, ...extra]) || record.version !== ORGANIZATION_HANDOFF_CAPABILITY_VERSION
      || state !== "pending" && state !== "finalized" && state !== "attach_closed") return fail();
    const pending = createOrganizationHandoffCapabilityPending({ bindingDigest: record.binding_digest,
      containerName: record.container_name, deploymentLabels: record.deployment_labels,
      descriptorDigest: record.descriptor_digest, handoff: record.handoff,
      selectedTarget: record.selected_target, selectedTargetReceiptDigest: record.selected_target_receipt_digest });
    if (pending.pending_key !== record.pending_key) return fail();
    if (state === "pending") return pending;
    const containerId = record.container_id;
    if (typeof containerId !== "string" || !CONTAINER.test(containerId)) return fail();
    const handle = createOrganizationHandoffHandle(pending, containerId);
    if (record.organization_handoff_handle !== handle || handle === pending.handoff.network_attachment_handle
      || handle === pending.selected_target.handle) return fail();
    if (state === "finalized") return Object.freeze({ ...pending, container_id: containerId,
      organization_handoff_handle: handle, state: "finalized" });
    return Object.freeze({ ...pending, container_id: containerId, organization_handoff_handle: handle,
      state: "attach_closed" });
  } catch { return fail(); }
};

export const parseOrganizationAttachmentAuthorizationForDeployment = (raw: unknown): {
  readonly descriptor_digest: string; readonly operation_handle: OpaqueTargetHandle;
  readonly organization_handoff_handle: OpaqueTargetHandle; readonly request_digest: string;
  readonly run_id: string; readonly selected_target: { readonly fingerprint: string; readonly handle: OpaqueTargetHandle };
  readonly version: "spawnfile.target-organization-attachment.authorization.v1";
} => {
  try {
    assertOrdinaryJsonGraph(raw); const record = raw as Record<string, unknown>;
    const keys = ["descriptor_digest", "operation_handle", "organization_handoff_handle", "request_digest", "run_id", "selected_target", "version"];
    if (!exact(raw, keys) || record.version !== "spawnfile.target-organization-attachment.authorization.v1"
      || !exact(record.selected_target, ["fingerprint", "handle"])) return fail();
    const selected = parseSelectedTargetReceipt({ ...record.selected_target, version: "spawnfile.target-resource.selected-target.v1" });
    const operationHandle = parseOpaqueTargetHandle(record.operation_handle);
    const handoffHandle = parseOpaqueTargetHandle(record.organization_handoff_handle);
    if (operationHandle === handoffHandle || operationHandle === selected.handle || handoffHandle === selected.handle) return fail();
    return Object.freeze({ descriptor_digest: digest(record.descriptor_digest), operation_handle: operationHandle,
      organization_handoff_handle: handoffHandle, request_digest: digest(record.request_digest),
      run_id: parseRunId(record.run_id), selected_target: Object.freeze({ fingerprint: selected.fingerprint, handle: selected.handle }),
      version: "spawnfile.target-organization-attachment.authorization.v1" });
  } catch { return fail(); }
};
