import { createHash } from "node:crypto";

import { z } from "zod";

import {
  assertOrdinaryJsonGraph,
  parseSelectedTargetReceipt,
  parseTargetResourceReceipt,
  parseTargetResourceRequest,
  type SelectedTargetReceipt,
  type TargetResourceReceipt,
  type TargetResourceRequest,
} from "./contracts.js";
import {
  createCanonicalTargetReceiptBytes,
  createTargetReceiptDigest,
  createTargetRequestDigest,
} from "./handles.js";

export const COMPOSED_PREPARATION_REQUEST_VERSION =
  "spawnfile.composed-preparation.request.v1" as const;
export const COMPOSED_PREPARATION_RECEIPT_VERSION =
  "spawnfile.composed-preparation.receipt.v1" as const;

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const idempotencyKey = z.string().regex(/^idem_[a-z0-9]{16,64}$/u);
const opaqueHandle = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u);

export const composedPreparationRequestSchema = z.object({
  auth_profile: identifier,
  descriptor_digest: digest,
  idempotency_key: idempotencyKey,
  organization: z.object({
    artifact_digest: digest,
    world_bindings_digest: digest,
  }).strict(),
  run_id: runId,
  secret_bindings: z.array(z.object({
    name: identifier,
    scope: identifier,
    source_handle: opaqueHandle,
  }).strict()).min(1).max(32),
  target_selector: identifier,
  version: z.literal(COMPOSED_PREPARATION_REQUEST_VERSION),
  world: z.object({
    artifact_manifest_digest: digest,
    bundle_digest: digest,
  }).strict(),
}).strict();

const selectedTarget = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{32}$/u),
  handle: opaqueHandle,
  version: z.literal("spawnfile.target-resource.selected-target.v1"),
}).strict();
const mutationReceipt = z.object({
  cleanup_state: z.enum(["not_requested", "preserved", "removed", "incomplete"]).nullable(),
  descriptor_digest: digest,
  export_state: z.enum(["not_requested", "exported", "incomplete"]).nullable(),
  labels: z.array(z.object({ key: identifier, value: identifier }).strict()).max(16),
  operation: z.enum([
    "resolve_world_artifact", "prepare_secret_bindings",
    "create_data_network", "create_evidence_volume",
  ]),
  operation_handle: opaqueHandle,
  receipt_digest: digest,
  request_digest: digest,
  result_handle: opaqueHandle,
  resulting_revision: z.number().int().min(1).max(4),
  run_id: runId,
  selected_target: selectedTarget.omit({ version: true }),
  version: z.literal("spawnfile.target-resource.receipt.v1"),
}).strict();

export const composedPreparationReceiptSchema = z.object({
  auth_profile: identifier,
  descriptor_digest: digest,
  organization: z.object({
    artifact_digest: digest,
    world_bindings_digest: digest,
  }).strict(),
  receipt_digest: digest,
  request_digest: digest,
  resources: z.object({
    data_network: mutationReceipt,
    evidence_volume: mutationReceipt,
    secret_bindings: mutationReceipt,
    world_artifact: mutationReceipt,
  }).strict(),
  run_id: runId,
  selected_target: selectedTarget,
  target_selector: identifier,
  version: z.literal(COMPOSED_PREPARATION_RECEIPT_VERSION),
  world: z.object({
    artifact_manifest_digest: digest,
    bundle_digest: digest,
  }).strict(),
}).strict().superRefine((value, context) => {
  const ordered = [
    ["world_artifact", "resolve_world_artifact", 1],
    ["secret_bindings", "prepare_secret_bindings", 2],
    ["data_network", "create_data_network", 3],
    ["evidence_volume", "create_evidence_volume", 4],
  ] as const;
  for (const [key, operation, revision] of ordered) {
    const receipt = value.resources[key];
    if (receipt.operation !== operation || receipt.resulting_revision !== revision
      || receipt.run_id !== value.run_id
      || receipt.descriptor_digest !== value.descriptor_digest
      || receipt.selected_target.handle !== value.selected_target.handle
      || receipt.selected_target.fingerprint !== value.selected_target.fingerprint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `composed preparation ${key} correlation is invalid`,
      });
    }
  }
  if (value.resources.world_artifact.result_handle === value.resources.secret_bindings.result_handle
    || new Set(ordered.map(([key]) => value.resources[key].operation_handle)).size !== ordered.length
    || new Set(ordered.map(([key]) => value.resources[key].result_handle)).size !== ordered.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "composed preparation resource identities are not unique",
    });
  }
});

export type ComposedPreparationRequest = z.infer<typeof composedPreparationRequestSchema>;
export type ComposedPreparationReceipt = z.infer<typeof composedPreparationReceiptSchema>;

export interface ComposedPreparationMutationResult {
  readonly receipt: unknown;
  readonly receiptBytes: unknown;
}

export type ComposedPreparationHandlers = {
  [Operation in TargetResourceRequest["operation"]]: (
    request: Extract<TargetResourceRequest, { operation: Operation }>,
  ) => Promise<Operation extends "select_target"
    ? SelectedTargetReceipt
    : ComposedPreparationMutationResult>;
};

const canonical = (value: unknown): string => {
  assertOrdinaryJsonGraph(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const hash = (domain: string, value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(`${domain}\0${canonical(value)}`).digest("hex")}`;

export const parseComposedPreparationRequest = (raw: unknown): ComposedPreparationRequest => {
  assertOrdinaryJsonGraph(raw);
  return composedPreparationRequestSchema.parse(raw);
};

export const createComposedPreparationRequestDigest = (raw: unknown): `sha256:${string}` =>
  hash(COMPOSED_PREPARATION_REQUEST_VERSION, parseComposedPreparationRequest(raw));

export const parseComposedPreparationReceipt = (raw: unknown): ComposedPreparationReceipt => {
  assertOrdinaryJsonGraph(raw);
  const receipt = composedPreparationReceiptSchema.parse(raw);
  const { receipt_digest: _digest, ...body } = receipt;
  if (receipt.receipt_digest !== hash(COMPOSED_PREPARATION_RECEIPT_VERSION, body)) {
    throw new TypeError("Composed preparation receipt digest is invalid");
  }
  return Object.freeze(receipt);
};

export const createCanonicalComposedPreparationReceiptBytes = (raw: unknown): string =>
  canonical(parseComposedPreparationReceipt(raw));

const operationKey = (
  request: ComposedPreparationRequest,
  operation: string,
): `idem_${string}` => `idem_${createHash("sha256")
  .update(`${request.idempotency_key}\0${operation}`, "utf8").digest("hex").slice(0, 32)}`;

const selectionRequest = (request: ComposedPreparationRequest): Extract<
  TargetResourceRequest,
  { operation: "select_target" }
> => parseTargetResourceRequest({
  idempotency_key: operationKey(request, "select_target"),
  operation: "select_target",
  target_reference: request.target_selector,
  version: "spawnfile.target-resource.request.v1",
}) as Extract<TargetResourceRequest, { operation: "select_target" }>;

const mutationEnvelope = (
  request: ComposedPreparationRequest,
  target: SelectedTargetReceipt,
  operation: string,
  revision: number,
) => ({
  descriptor_digest: request.descriptor_digest,
  expected_revision: revision,
  idempotency_key: operationKey(request, operation),
  run_id: request.run_id,
  selected_target: { fingerprint: target.fingerprint, handle: target.handle },
  version: "spawnfile.target-resource.request.v1" as const,
});

const validateMutation = (
  raw: ComposedPreparationMutationResult,
  request: TargetResourceRequest,
  expectedRevision: number,
): TargetResourceReceipt => {
  const receipt = parseTargetResourceReceipt(raw.receipt);
  if (typeof raw.receiptBytes !== "string"
    || raw.receiptBytes !== createCanonicalTargetReceiptBytes(receipt)
    || receipt.receipt_digest !== createTargetReceiptDigest(receipt)
    || receipt.request_digest !== createTargetRequestDigest(request)
    || receipt.operation !== request.operation
    || receipt.run_id !== ("run_id" in request ? request.run_id : null)
    || receipt.descriptor_digest !== ("descriptor_digest" in request ? request.descriptor_digest : null)
    || receipt.resulting_revision !== expectedRevision
    || receipt.result_handle === null) {
    throw new TypeError("Composed preparation operation receipt is invalid");
  }
  return receipt;
};

const sameSelectedTarget = (
  receipt: TargetResourceReceipt,
  target: SelectedTargetReceipt,
): boolean => canonical(receipt.selected_target) === canonical({
  fingerprint: target.fingerprint,
  handle: target.handle,
});

export const prepareComposedRun = async (
  handlers: ComposedPreparationHandlers,
  raw: unknown,
): Promise<ComposedPreparationReceipt> => {
  const request = parseComposedPreparationRequest(raw);
  const selected = parseSelectedTargetReceipt(await handlers.select_target(selectionRequest(request)));
  const requests = [
    parseTargetResourceRequest({
      ...mutationEnvelope(request, selected, "resolve_world_artifact", 0),
      artifact_manifest_digest: request.world.artifact_manifest_digest,
      operation: "resolve_world_artifact" as const,
    }),
    parseTargetResourceRequest({
      ...mutationEnvelope(request, selected, "prepare_secret_bindings", 1),
      bindings: request.secret_bindings,
      operation: "prepare_secret_bindings" as const,
    }),
    parseTargetResourceRequest({
      ...mutationEnvelope(request, selected, "create_data_network", 2),
      operation: "create_data_network" as const,
    }),
    parseTargetResourceRequest({
      ...mutationEnvelope(request, selected, "create_evidence_volume", 3),
      operation: "create_evidence_volume" as const,
    }),
  ];
  const receipts: TargetResourceReceipt[] = [];
  for (const [index, operationRequest] of requests.entries()) {
    const handler = handlers[operationRequest.operation] as (
      value: typeof operationRequest,
    ) => Promise<ComposedPreparationMutationResult>;
    const receipt = validateMutation(
      await handler(operationRequest),
      operationRequest,
      index + 1,
    );
    if (!sameSelectedTarget(receipt, selected)) {
      throw new TypeError("Composed preparation selected target changed");
    }
    receipts.push(receipt);
  }
  const body = {
    auth_profile: request.auth_profile,
    descriptor_digest: request.descriptor_digest,
    organization: request.organization,
    receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: createComposedPreparationRequestDigest(request),
    resources: {
      data_network: receipts[2],
      evidence_volume: receipts[3],
      secret_bindings: receipts[1],
      world_artifact: receipts[0],
    },
    run_id: request.run_id,
    selected_target: selected,
    target_selector: request.target_selector,
    version: COMPOSED_PREPARATION_RECEIPT_VERSION,
    world: request.world,
  };
  return parseComposedPreparationReceipt({
    ...body,
    receipt_digest: hash(COMPOSED_PREPARATION_RECEIPT_VERSION, (({
      receipt_digest: _receiptDigest,
      ...unsigned
    }) => unsigned)(body)),
  });
};
