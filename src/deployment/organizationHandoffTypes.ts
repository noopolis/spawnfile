import { createHash } from "node:crypto";

import { z } from "zod";

import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseRunId,
  type OpaqueTargetHandle,
  type RunId
} from "../target/index.js";

export const ORGANIZATION_HANDOFF_VERSION = "spawnfile.organization-handoff.v1" as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const lifecycleReceiptsSchema = z.object({
  down: z.literal("spawnfile.down-receipt.v1"),
  export: z.literal("spawnfile.export-index.v1"),
  up: z.literal("spawnfile.up-receipt.v1")
}).strict();

declare const canonicalSha256Digest: unique symbol;
export type CanonicalSha256Digest = string & {
  readonly [canonicalSha256Digest]: "CanonicalSha256Digest";
};

export interface OrganizationHandoffInput {
  bindingDigest: CanonicalSha256Digest;
  networkAttachmentHandle: OpaqueTargetHandle;
  selectedTargetReceiptDigest: CanonicalSha256Digest;
}

export interface OrganizationHandoff {
  binding_digest: CanonicalSha256Digest;
  deployment_handle: string;
  lifecycle_receipts: {
    down: "spawnfile.down-receipt.v1";
    export: "spawnfile.export-index.v1";
    up: "spawnfile.up-receipt.v1";
  };
  network_attachment_handle: OpaqueTargetHandle;
  run_id: RunId;
  selected_target_receipt_digest: CanonicalSha256Digest;
  version: typeof ORGANIZATION_HANDOFF_VERSION;
}

const parseError = (label: string, detail: string): never => {
  throw new Error(`invalid ${ORGANIZATION_HANDOFF_VERSION} ${label}: ${detail}`);
};

export const parseCanonicalSha256Digest = (
  value: unknown,
  label = "digest"
): CanonicalSha256Digest => {
  const parsed = digestSchema.safeParse(value);
  if (!parsed.success) parseError(label, "must be a canonical sha256 digest");
  return parsed.data as CanonicalSha256Digest;
};

const lifecycleReceipts = {
  down: "spawnfile.down-receipt.v1",
  export: "spawnfile.export-index.v1",
  up: "spawnfile.up-receipt.v1"
} as const;

const canonicalDerivationBytes = (input: Omit<OrganizationHandoff, "deployment_handle" | "version">): string =>
  [
    "spawnfile.organization-handoff.v1\0",
    input.run_id,
    input.selected_target_receipt_digest,
    input.network_attachment_handle,
    input.binding_digest,
    input.lifecycle_receipts.up,
    input.lifecycle_receipts.export,
    input.lifecycle_receipts.down
  ].join("\n");

export const createOrganizationDeploymentHandle = (
  input: Omit<OrganizationHandoff, "deployment_handle" | "version">
): string =>
  `sf-oh1-${createHash("sha256").update(canonicalDerivationBytes(input), "utf8").digest("hex")}`;

export const createOrganizationHandoff = (
  runId: unknown,
  input: OrganizationHandoffInput
): OrganizationHandoff => {
  const handoff = {
    binding_digest: parseCanonicalSha256Digest(input.bindingDigest, "binding_digest"),
    lifecycle_receipts: lifecycleReceipts,
    network_attachment_handle: parseOpaqueTargetHandle(input.networkAttachmentHandle),
    run_id: parseRunId(runId),
    selected_target_receipt_digest: parseCanonicalSha256Digest(
      input.selectedTargetReceiptDigest,
      "selected_target_receipt_digest"
    )
  };
  return {
    ...handoff,
    deployment_handle: createOrganizationDeploymentHandle(handoff),
    version: ORGANIZATION_HANDOFF_VERSION
  };
};

const organizationHandoffSchema = z.object({
  binding_digest: digestSchema,
  deployment_handle: z.string().regex(/^sf-oh1-[a-f0-9]{64}$/u),
  lifecycle_receipts: lifecycleReceiptsSchema,
  network_attachment_handle: z.string(),
  run_id: z.string(),
  selected_target_receipt_digest: digestSchema,
  version: z.literal(ORGANIZATION_HANDOFF_VERSION)
}).strict();

export const parseOrganizationHandoff = (value: unknown): OrganizationHandoff => {
  try {
    assertOrdinaryJsonGraph(value);
    const parsed = organizationHandoffSchema.safeParse(value);
    if (!parsed.success) throw new TypeError();
    const handoff = {
      binding_digest: parseCanonicalSha256Digest(parsed.data.binding_digest, "binding_digest"),
      lifecycle_receipts: parsed.data.lifecycle_receipts,
      network_attachment_handle: parseOpaqueTargetHandle(parsed.data.network_attachment_handle),
      run_id: parseRunId(parsed.data.run_id),
      selected_target_receipt_digest: parseCanonicalSha256Digest(
        parsed.data.selected_target_receipt_digest,
        "selected_target_receipt_digest"
      )
    };
    const expectedHandle = createOrganizationDeploymentHandle(handoff);
    if (parsed.data.deployment_handle !== expectedHandle) throw new TypeError();
    return { ...handoff, deployment_handle: expectedHandle, version: ORGANIZATION_HANDOFF_VERSION };
  } catch {
    return parseError("artifact", "must be a bounded canonical handoff");
  }
};
