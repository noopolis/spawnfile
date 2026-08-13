import { createHash } from "node:crypto";

import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseRunId,
  parseSelectedTargetReceipt,
  type OpaqueTargetHandle,
  type SelectedTargetReceipt
} from "./contracts.js";
import {
  ORGANIZATION_ATTACHMENT_ERROR,
  parseOrganizationContainerId,
  parseOrganizationDeploymentLabels,
  type OrganizationDeploymentLabels
} from "./organizationAttachmentProvider.js";

export const ORGANIZATION_ATTACHMENT_AUTHORIZATION_VERSION =
  "spawnfile.target-organization-attachment.authorization.v1" as const;
export const ORGANIZATION_HANDOFF_VERSION = "spawnfile.organization-handoff.v1" as const;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{32}$/u;
const DEPLOYMENT_HANDLE_PATTERN = /^sf-oh1-[a-f0-9]{64}$/u;

export interface OrganizationAttachmentAuthorization {
  readonly descriptor_digest: string;
  readonly operation_handle: OpaqueTargetHandle;
  readonly organization_handoff_handle: OpaqueTargetHandle;
  readonly request_digest: string;
  readonly run_id: string;
  readonly selected_target: {
    readonly fingerprint: string;
    readonly handle: OpaqueTargetHandle;
  };
  readonly version: typeof ORGANIZATION_ATTACHMENT_AUTHORIZATION_VERSION;
}

export interface ResolvedOrganizationHandoff {
  readonly binding_digest: string;
  readonly deployment_handle: string;
  readonly lifecycle_receipts: {
    readonly down: "spawnfile.down-receipt.v1";
    readonly export: "spawnfile.export-index.v1";
    readonly up: "spawnfile.up-receipt.v1";
  };
  readonly network_attachment_handle: OpaqueTargetHandle;
  readonly run_id: string;
  readonly selected_target_receipt_digest: string;
  readonly version: typeof ORGANIZATION_HANDOFF_VERSION;
}

export interface OrganizationAttachmentResolution {
  readonly authorization: OrganizationAttachmentAuthorization;
  readonly descriptor_binding: {
    readonly binding_digest: string;
    readonly descriptor_digest: string;
  };
  readonly handoff: ResolvedOrganizationHandoff;
  readonly network_attachment: {
    readonly container_id: string;
    readonly deployment_labels: OrganizationDeploymentLabels;
    readonly network_attachment_handle: OpaqueTargetHandle;
  };
  readonly selected_target_binding: {
    readonly receipt: SelectedTargetReceipt;
    readonly receipt_digest: string;
  };
}

export interface OrganizationAttachmentResolverInput {
  readonly authorization: OrganizationAttachmentAuthorization;
  readonly signal?: AbortSignal;
}

/** Trusted operator seam from one opaque handoff capability to exact private identity. */
export interface OrganizationAttachmentResolver {
  resolve(input: OrganizationAttachmentResolverInput): Promise<unknown>;
}

const fail = (): never => { throw new Error(ORGANIZATION_ATTACHMENT_ERROR); };
const ordinary = (raw: unknown): void => {
  try { assertOrdinaryJsonGraph(raw); } catch { return fail(); }
};
const exactRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
};
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) return fail();
  return value;
};
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const createOrganizationAttachmentAuthorization = (input: {
  readonly descriptorDigest: unknown;
  readonly operationHandle: unknown;
  readonly organizationHandoffHandle: unknown;
  readonly requestDigest: unknown;
  readonly runId: unknown;
  readonly selectedTarget: unknown;
}): OrganizationAttachmentAuthorization => {
  const selected = parseSelectedTargetReceipt({
    ...(exactRecord(input.selectedTarget) ? input.selectedTarget : {}),
    version: "spawnfile.target-resource.selected-target.v1"
  });
  return Object.freeze({
    descriptor_digest: digest(input.descriptorDigest),
    operation_handle: parseOpaqueTargetHandle(input.operationHandle),
    organization_handoff_handle: parseOpaqueTargetHandle(input.organizationHandoffHandle),
    request_digest: digest(input.requestDigest),
    run_id: parseRunId(input.runId),
    selected_target: Object.freeze({ fingerprint: selected.fingerprint, handle: selected.handle }),
    version: ORGANIZATION_ATTACHMENT_AUTHORIZATION_VERSION
  });
};

export const parseOrganizationAttachmentAuthorization = (
  raw: unknown
): OrganizationAttachmentAuthorization => {
  ordinary(raw);
  if (!exactRecord(raw) || !exactKeys(raw, [
    "descriptor_digest", "operation_handle", "organization_handoff_handle",
    "request_digest", "run_id", "selected_target", "version"
  ]) || raw.version !== ORGANIZATION_ATTACHMENT_AUTHORIZATION_VERSION
    || !exactRecord(raw.selected_target)
    || !exactKeys(raw.selected_target, ["fingerprint", "handle"])
    || typeof raw.selected_target.fingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(raw.selected_target.fingerprint)) return fail();
  return createOrganizationAttachmentAuthorization({
    descriptorDigest: raw.descriptor_digest,
    operationHandle: raw.operation_handle,
    organizationHandoffHandle: raw.organization_handoff_handle,
    requestDigest: raw.request_digest,
    runId: raw.run_id,
    selectedTarget: raw.selected_target
  });
};

const handoffHandle = (input: Omit<ResolvedOrganizationHandoff, "deployment_handle" | "version">): string => {
  const canonical = [
    "spawnfile.organization-handoff.v1\0",
    input.run_id,
    input.selected_target_receipt_digest,
    input.network_attachment_handle,
    input.binding_digest,
    input.lifecycle_receipts.up,
    input.lifecycle_receipts.export,
    input.lifecycle_receipts.down
  ].join("\n");
  return `sf-oh1-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
};

export const parseResolvedOrganizationHandoff = (raw: unknown): ResolvedOrganizationHandoff => {
  ordinary(raw);
  if (!exactRecord(raw) || !exactKeys(raw, [
    "binding_digest", "deployment_handle", "lifecycle_receipts",
    "network_attachment_handle", "run_id", "selected_target_receipt_digest", "version"
  ]) || raw.version !== ORGANIZATION_HANDOFF_VERSION
    || typeof raw.deployment_handle !== "string"
    || !DEPLOYMENT_HANDLE_PATTERN.test(raw.deployment_handle)
    || !exactRecord(raw.lifecycle_receipts)
    || !exactKeys(raw.lifecycle_receipts, ["down", "export", "up"])
    || raw.lifecycle_receipts.down !== "spawnfile.down-receipt.v1"
    || raw.lifecycle_receipts.export !== "spawnfile.export-index.v1"
    || raw.lifecycle_receipts.up !== "spawnfile.up-receipt.v1") return fail();
  const body = {
    binding_digest: digest(raw.binding_digest),
    lifecycle_receipts: Object.freeze({
      down: "spawnfile.down-receipt.v1" as const,
      export: "spawnfile.export-index.v1" as const,
      up: "spawnfile.up-receipt.v1" as const
    }),
    network_attachment_handle: parseOpaqueTargetHandle(raw.network_attachment_handle),
    run_id: parseRunId(raw.run_id),
    selected_target_receipt_digest: digest(raw.selected_target_receipt_digest)
  };
  if (raw.deployment_handle !== handoffHandle(body)) return fail();
  return Object.freeze({
    ...body,
    deployment_handle: raw.deployment_handle,
    version: ORGANIZATION_HANDOFF_VERSION
  });
};

export const parseOrganizationAttachmentResolution = (
  raw: unknown
): OrganizationAttachmentResolution => {
  ordinary(raw);
  if (!exactRecord(raw) || !exactKeys(raw, [
    "authorization", "descriptor_binding", "handoff",
    "network_attachment", "selected_target_binding"
  ]) || !exactRecord(raw.descriptor_binding)
    || !exactKeys(raw.descriptor_binding, ["binding_digest", "descriptor_digest"])
    || !exactRecord(raw.network_attachment)
    || !exactKeys(raw.network_attachment, [
      "container_id", "deployment_labels", "network_attachment_handle"
    ]) || !exactRecord(raw.selected_target_binding)
    || !exactKeys(raw.selected_target_binding, ["receipt", "receipt_digest"])) return fail();
  const authorization = parseOrganizationAttachmentAuthorization(raw.authorization);
  const handoff = parseResolvedOrganizationHandoff(raw.handoff);
  const receipt = parseSelectedTargetReceipt(raw.selected_target_binding.receipt);
  const resolution = Object.freeze({
    authorization,
    descriptor_binding: Object.freeze({
      binding_digest: digest(raw.descriptor_binding.binding_digest),
      descriptor_digest: digest(raw.descriptor_binding.descriptor_digest)
    }),
    handoff,
    network_attachment: Object.freeze({
      container_id: parseOrganizationContainerId(raw.network_attachment.container_id),
      deployment_labels: parseOrganizationDeploymentLabels(
        raw.network_attachment.deployment_labels
      ),
      network_attachment_handle: parseOpaqueTargetHandle(
        raw.network_attachment.network_attachment_handle
      )
    }),
    selected_target_binding: Object.freeze({
      receipt,
      receipt_digest: digest(raw.selected_target_binding.receipt_digest)
    })
  });
  if (resolution.descriptor_binding.descriptor_digest !== authorization.descriptor_digest
    || resolution.descriptor_binding.binding_digest !== handoff.binding_digest
    || handoff.run_id !== authorization.run_id
    || resolution.network_attachment.network_attachment_handle
      !== handoff.network_attachment_handle
    || resolution.network_attachment.deployment_labels["com.spawnfile.run_id"]
      !== authorization.run_id
    || resolution.selected_target_binding.receipt_digest
      !== handoff.selected_target_receipt_digest
    || !same({
      fingerprint: resolution.selected_target_binding.receipt.fingerprint,
      handle: resolution.selected_target_binding.receipt.handle
    }, authorization.selected_target)) return fail();
  return resolution;
};
