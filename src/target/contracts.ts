import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import { z } from "zod";

import { TARGET_EXPORT_INDEX_VERSION, targetResourceExportIndexSchema } from "./evidenceExportContract.js";
export { TARGET_EXPORT_INDEX_VERSION, targetResourceExportIndexSchema } from "./evidenceExportContract.js";

export const TARGET_RESOURCE_REQUEST_VERSION = "spawnfile.target-resource.request.v1" as const;
export const TARGET_RESOURCE_RECEIPT_VERSION = "spawnfile.target-resource.receipt.v1" as const;
export const SELECTED_TARGET_VERSION = "spawnfile.target-resource.selected-target.v1" as const;
export const TARGET_JOURNAL_VERSION = "spawnfile.target-resource.journal.v1" as const;
export const TARGET_OPERATION_LOOKUP_VERSION =
  "spawnfile.target-resource.operation-lookup.v1" as const;
/**
 * Read-only owner attestation.  This is deliberately not a target-resource
 * mutation: it neither reserves a journal operation nor grants a Docker
 * capability to its caller.
 */
export const TARGET_TOPOLOGY_ATTESTATION_REQUEST_VERSION =
  "spawnfile.target-topology-attestation.request.v1" as const;
export const TARGET_TOPOLOGY_RECEIPT_VERSION =
  "spawnfile.target-topology-receipt.v1" as const;

const identifierSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const containerPathSchema = z.string().max(255).regex(/^\/(?:run|var\/lib)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine((value) => !value.includes("//") && !value.endsWith("/")
    && !value.split("/").some((part) => part === "." || part === ".."))
  .refine((value) => value !== "/run/spawnfile-secrets"
    && !value.startsWith("/run/spawnfile-secrets/")
    && !"/run/spawnfile-secrets".startsWith(`${value}/`));
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
declare const runIdBrand: unique symbol;
export type RunId = string & { readonly [runIdBrand]: "RunId" };
export const runIdSchema = z.string()
  .regex(RUN_ID_PATTERN)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 128)
  .transform((value) => value as RunId);
export const parseRunId = (raw: unknown): RunId => {
  assertOrdinaryJsonGraph(raw);
  return runIdSchema.parse(raw);
};
declare const opaqueTargetHandleBrand: unique symbol;
export type OpaqueTargetHandle = string & { readonly [opaqueTargetHandleBrand]: "OpaqueTargetHandle" };
export const opaqueTargetHandleSchema = z.string().regex(/^opaque_[a-z0-9]{16,64}$/u).transform((value) => value as OpaqueTargetHandle);
export const parseOpaqueTargetHandle = (raw: unknown): OpaqueTargetHandle => {
  assertOrdinaryJsonGraph(raw);
  return opaqueTargetHandleSchema.parse(raw);
};
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{32}$/u);
const revisionSchema = z.number().int().min(0).max(2_147_483_647);
const idempotencyKeySchema = z.string().regex(/^idem_[a-z0-9]{16,64}$/u);
const operationSchema = z.enum([
  "select_target", "resolve_world_artifact", "prepare_secret_bindings", "create_data_network",
  "create_evidence_volume", "attach_organization", "create_world_service", "start_world_service",
  "stop_world_service", "detach_organization", "export_evidence_volume", "revoke_secret_bindings",
  "cleanup_run", "recover_operation"
]);

export const selectedTargetSchema = z.object({
  fingerprint: fingerprintSchema,
  handle: opaqueTargetHandleSchema
}).strict();

const mutationEnvelopeSchema = {
  descriptor_digest: digestSchema,
  expected_revision: revisionSchema,
  idempotency_key: idempotencyKeySchema,
  run_id: runIdSchema,
  selected_target: selectedTargetSchema
};

const selectTargetRequestSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  operation: z.literal("select_target"),
  target_reference: identifierSchema,
  version: z.literal(TARGET_RESOURCE_REQUEST_VERSION)
}).strict();

const resolveWorldArtifactRequestSchema = z.object({
  ...mutationEnvelopeSchema,
  artifact_manifest_digest: digestSchema,
  operation: z.literal("resolve_world_artifact"),
  version: z.literal(TARGET_RESOURCE_REQUEST_VERSION)
}).strict();

const prepareSecretBindingsRequestSchema = z.object({
  ...mutationEnvelopeSchema,
  bindings: z.array(z.object({ name: identifierSchema, scope: identifierSchema, source_handle: opaqueTargetHandleSchema }).strict()).min(1).max(32),
  operation: z.literal("prepare_secret_bindings"),
  version: z.literal(TARGET_RESOURCE_REQUEST_VERSION)
}).strict();

const createDataNetworkRequestSchema = z.object({ ...mutationEnvelopeSchema, operation: z.literal("create_data_network"), version: z.literal(TARGET_RESOURCE_REQUEST_VERSION) }).strict();
const createEvidenceVolumeRequestSchema = z.object({ ...mutationEnvelopeSchema, operation: z.literal("create_evidence_volume"), version: z.literal(TARGET_RESOURCE_REQUEST_VERSION) }).strict();

const attachOrganizationRequestSchema = z.object({
  ...mutationEnvelopeSchema,
  data_network_handle: opaqueTargetHandleSchema,
  organization_handoff_handle: opaqueTargetHandleSchema,
  operation: z.literal("attach_organization"),
  version: z.literal(TARGET_RESOURCE_REQUEST_VERSION)
}).strict();

const createWorldServiceRequestSchema = z.object({
  ...mutationEnvelopeSchema,
  data_network_handle: opaqueTargetHandleSchema,
  evidence_mount_path: containerPathSchema,
  evidence_volume_handle: opaqueTargetHandleSchema,
  operation: z.literal("create_world_service"),
  secret_bindings_handle: opaqueTargetHandleSchema,
  world_artifact_handle: opaqueTargetHandleSchema,
  version: z.literal(TARGET_RESOURCE_REQUEST_VERSION)
}).strict();

const serviceRequest = (operation: "start_world_service" | "stop_world_service") => z.object({
  ...mutationEnvelopeSchema,
  operation: z.literal(operation),
  world_service_handle: opaqueTargetHandleSchema,
  version: z.literal(TARGET_RESOURCE_REQUEST_VERSION)
}).strict();

const detachOrganizationRequestSchema = z.object({
  ...mutationEnvelopeSchema,
  data_network_handle: opaqueTargetHandleSchema,
  operation: z.literal("detach_organization"),
  organization_attachment_handle: opaqueTargetHandleSchema,
  version: z.literal(TARGET_RESOURCE_REQUEST_VERSION)
}).strict();

const exportEvidenceVolumeRequestSchema = z.object({ ...mutationEnvelopeSchema, evidence_volume_handle: opaqueTargetHandleSchema, operation: z.literal("export_evidence_volume"), version: z.literal(TARGET_RESOURCE_REQUEST_VERSION) }).strict();
const revokeSecretBindingsRequestSchema = z.object({ ...mutationEnvelopeSchema, operation: z.literal("revoke_secret_bindings"), secret_bindings_handle: opaqueTargetHandleSchema, version: z.literal(TARGET_RESOURCE_REQUEST_VERSION) }).strict();

const cleanupRunRequestSchema = z.object({
  ...mutationEnvelopeSchema,
  cleanup_policy: z.enum(["discard_evidence", "remove", "preserve_evidence"]),
  evidence_volume_handle: opaqueTargetHandleSchema.optional(),
  operation: z.literal("cleanup_run"),
  organization_attachment_handle: opaqueTargetHandleSchema.optional(),
  secret_bindings_handle: opaqueTargetHandleSchema.optional(),
  version: z.literal(TARGET_RESOURCE_REQUEST_VERSION),
  world_service_handle: opaqueTargetHandleSchema.optional()
}).strict();

const recoverOperationRequestSchema = z.object({ ...mutationEnvelopeSchema, operation: z.literal("recover_operation"), operation_handle: opaqueTargetHandleSchema, version: z.literal(TARGET_RESOURCE_REQUEST_VERSION) }).strict();

export const targetResourceRequestSchema = z.discriminatedUnion("operation", [
  selectTargetRequestSchema, resolveWorldArtifactRequestSchema, prepareSecretBindingsRequestSchema,
  createDataNetworkRequestSchema, createEvidenceVolumeRequestSchema, attachOrganizationRequestSchema,
  createWorldServiceRequestSchema, serviceRequest("start_world_service"), serviceRequest("stop_world_service"),
  detachOrganizationRequestSchema, exportEvidenceVolumeRequestSchema, revokeSecretBindingsRequestSchema,
  cleanupRunRequestSchema, recoverOperationRequestSchema
]);

const labelSchema = z.object({ key: identifierSchema, value: identifierSchema }).strict();
const receiptSchema = z.object({
  cleanup_state: z.enum(["not_requested", "preserved", "removed", "incomplete"]).nullable(),
  descriptor_digest: digestSchema.nullable(),
  evidence_index: targetResourceExportIndexSchema.optional(),
  export_state: z.enum(["not_requested", "exported", "incomplete"]).nullable(),
  labels: z.array(labelSchema).max(16),
  operation: operationSchema,
  operation_handle: opaqueTargetHandleSchema,
  receipt_digest: digestSchema,
  request_digest: digestSchema,
  result_handle: opaqueTargetHandleSchema.nullable(),
  resulting_revision: revisionSchema.nullable(),
  run_id: runIdSchema.nullable(),
  selected_target: selectedTargetSchema.nullable(),
  version: z.literal(TARGET_RESOURCE_RECEIPT_VERSION)
}).strict().superRefine((value, context) => {
  const selection = value.operation === "select_target";
  if (selection && (value.run_id !== null || value.selected_target === null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "selection correlation is invalid" });
  if (!selection && (value.run_id === null || value.selected_target === null || value.descriptor_digest === null || value.resulting_revision === null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "mutation correlation is invalid" });
  if (selection && (value.descriptor_digest !== null || value.resulting_revision !== null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "selection mutation fields are invalid" });
  if ((value.operation === "export_evidence_volume") !== (value.evidence_index !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "evidence export index is invalid" });
  }
  if (value.evidence_index !== undefined && (value.export_state !== "exported"
    || value.result_handle !== value.evidence_index.export_handle
    || value.run_id !== value.evidence_index.run_id
    || JSON.stringify(value.labels) !== JSON.stringify(value.evidence_index.labels))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "evidence export receipt is invalid" });
  }
});

export const targetResourceReceiptSchema = receiptSchema;
export const selectedTargetReceiptSchema = z.object({ fingerprint: fingerprintSchema, handle: opaqueTargetHandleSchema, version: z.literal(SELECTED_TARGET_VERSION) }).strict();

const targetOperationLookupBaseSchema = {
  idempotency_key: idempotencyKeySchema,
  operation: operationSchema.exclude(["select_target"]),
  request_digest: digestSchema,
  version: z.literal(TARGET_OPERATION_LOOKUP_VERSION)
};
const targetOperationNotAppliedSchema = z.object({
  ...targetOperationLookupBaseSchema,
  status: z.literal("not_applied")
}).strict();
const targetOperationPendingSchema = z.object({
  ...targetOperationLookupBaseSchema,
  operation_handle: opaqueTargetHandleSchema,
  status: z.literal("pending")
}).strict();
const targetOperationCompletedSchema = z.object({
  ...targetOperationLookupBaseSchema,
  operation_handle: opaqueTargetHandleSchema,
  receipt: receiptSchema,
  status: z.literal("completed")
}).strict().superRefine((value, context) => {
  if (value.receipt.operation !== value.operation
    || value.receipt.operation_handle !== value.operation_handle
    || value.receipt.request_digest !== value.request_digest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "lookup receipt correlation is invalid"
    });
  }
});
export const targetOperationLookupSchema = z.discriminatedUnion("status", [
  targetOperationNotAppliedSchema,
  targetOperationPendingSchema,
  targetOperationCompletedSchema
]);

const journalEntrySchema = z.object({ operation: operationSchema, operation_handle: opaqueTargetHandleSchema, receipt_digest: digestSchema, request_digest: digestSchema, state: z.enum(["pending", "completed", "incomplete"]) }).strict();
export const targetResourceJournalSchema = z.object({
  descriptor_digest: digestSchema,
  entries: z.array(journalEntrySchema).max(128),
  revision: revisionSchema,
  run_id: runIdSchema,
  selected_target: selectedTargetSchema,
  version: z.literal(TARGET_JOURNAL_VERSION)
}).strict();

const completedOperationSchema = z.object({
  operation_handle: opaqueTargetHandleSchema,
  request_digest: digestSchema,
  result_handle: opaqueTargetHandleSchema
}).strict();

/**
 * Public correlation packet for one already-created composed deployment.  The
 * owner resolves every handle against its private stores; these values are
 * never Docker references.
 */
export const targetTopologyAttestationRequestSchema = z.object({
  data_network: completedOperationSchema,
  descriptor_digest: digestSchema,
  organization_attachment: completedOperationSchema,
  run_id: runIdSchema,
  selected_target: selectedTargetSchema,
  version: z.literal(TARGET_TOPOLOGY_ATTESTATION_REQUEST_VERSION),
  world_service: z.object({
    create: completedOperationSchema,
    start: completedOperationSchema
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.world_service.create.result_handle !== value.world_service.start.result_handle) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "world service handles disagree" });
  }
  const handles = [
    value.data_network.result_handle,
    value.organization_attachment.result_handle,
    value.world_service.create.result_handle
  ];
  if (new Set(handles).size !== handles.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "resource handles must be distinct" });
  }
  const operations = [
    value.data_network.operation_handle,
    value.organization_attachment.operation_handle,
    value.world_service.create.operation_handle,
    value.world_service.start.operation_handle
  ];
  if (new Set(operations).size !== operations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "operation handles must be distinct" });
  }
});

/**
 * Semantic-only projection.  It intentionally excludes every Docker name,
 * ID, context, endpoint, path, port value and provider observation.
 */
export const targetTopologyReceiptSchema = z.object({
  descriptor_digest: digestSchema,
  handoff_scope: z.literal("organization_to_private_service"),
  organization: z.object({
    data_network_attachment: z.literal("exact"),
    egress_policy: z.literal("egress_only")
  }).strict(),
  receipt_digest: digestSchema,
  request_digest: digestSchema,
  run_id: runIdSchema,
  selected_target: selectedTargetSchema,
  service_discovery: z.literal("dns_only"),
  version: z.literal(TARGET_TOPOLOGY_RECEIPT_VERSION),
  world_service: z.object({
    data_network_attachment: z.literal("exactly_one"),
    egress_policy: z.literal("none"),
    published_ports: z.literal("none")
  }).strict(),
  world_network: z.literal("private_internal")
}).strict();

export const MAX_JSON_GRAPH_DEPTH = 32;
export const MAX_JSON_GRAPH_NODES = 1_024;
export const MAX_JSON_GRAPH_KEYS = 128;
export const MAX_JSON_GRAPH_STRING_BYTES = 65_536;
const JSON_GRAPH_ERROR = "invalid JSON-like graph";
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;

export const assertOrdinaryJsonGraph = (raw: unknown): void => {
  try {
    const seen = new WeakSet<object>();
    const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: raw, depth: 0 }];
    let nodes = 0;
    let stringBytes = 0;
    while (pending.length > 0) {
      const item = pending.pop()!;
      const value = item.value;
      if (typeof value === "string") {
        stringBytes += Buffer.byteLength(value, "utf8");
        if (stringBytes > MAX_JSON_GRAPH_STRING_BYTES) throw new Error();
        continue;
      }
      if (value === null || typeof value === "boolean") continue;
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error();
        continue;
      }
      if (typeof value !== "object" || nodeTypes.isProxy(value)) throw new Error();
      if (item.depth > MAX_JSON_GRAPH_DEPTH || seen.has(value)) throw new Error();
      seen.add(value);
      nodes += 1;
      if (nodes > MAX_JSON_GRAPH_NODES) throw new Error();

      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
        const length = Object.getOwnPropertyDescriptor(value, "length");
        if (!length || !("value" in length) || !Number.isSafeInteger(length.value)
          || length.enumerable || length.configurable || length.value > MAX_JSON_GRAPH_KEYS) throw new Error();
        const keys = Reflect.ownKeys(value);
        if (keys.length !== length.value + 1 || keys.length > MAX_JSON_GRAPH_KEYS + 1) throw new Error();
        for (let index = 0; index < length.value; index += 1) {
          const key = String(index);
          if (!ARRAY_INDEX.test(key)) throw new Error();
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
          pending.push({ value: descriptor.value, depth: item.depth + 1 });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error();
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_JSON_GRAPH_KEYS) throw new Error();
      for (const key of keys) {
        if (typeof key !== "string") throw new Error();
        stringBytes += Buffer.byteLength(key, "utf8");
        if (stringBytes > MAX_JSON_GRAPH_STRING_BYTES) throw new Error();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
  } catch {
    throw new TypeError(JSON_GRAPH_ERROR);
  }
};

export type TargetResourceRequest = z.infer<typeof targetResourceRequestSchema>;
export type TargetResourceReceipt = z.infer<typeof targetResourceReceiptSchema>;
export type SelectedTargetReceipt = z.infer<typeof selectedTargetReceiptSchema>;
export type TargetResourceJournal = z.infer<typeof targetResourceJournalSchema>;
export type TargetResourceExportIndex = z.infer<typeof targetResourceExportIndexSchema>;
export type TargetMutationRequest = Exclude<TargetResourceRequest, { operation: "select_target" }>;
export type TargetOperationLookup = z.infer<typeof targetOperationLookupSchema>;
export type TargetTopologyAttestationRequest = z.infer<typeof targetTopologyAttestationRequestSchema>;
export type TargetTopologyReceipt = z.infer<typeof targetTopologyReceiptSchema>;

export const parseTargetResourceRequest = (raw: unknown): TargetResourceRequest => { assertOrdinaryJsonGraph(raw); return targetResourceRequestSchema.parse(raw); };
export const parseTargetResourceReceipt = (raw: unknown): TargetResourceReceipt => { assertOrdinaryJsonGraph(raw); return targetResourceReceiptSchema.parse(raw); };
export const parseSelectedTargetReceipt = (raw: unknown): SelectedTargetReceipt => { assertOrdinaryJsonGraph(raw); return selectedTargetReceiptSchema.parse(raw); };
export const parseTargetResourceJournal = (raw: unknown): TargetResourceJournal => { assertOrdinaryJsonGraph(raw); return targetResourceJournalSchema.parse(raw); };
export const parseTargetResourceExportIndex = (raw: unknown): TargetResourceExportIndex => { assertOrdinaryJsonGraph(raw); return targetResourceExportIndexSchema.parse(raw); };
export const parseTargetOperationLookup = (raw: unknown): TargetOperationLookup => {
  assertOrdinaryJsonGraph(raw); return targetOperationLookupSchema.parse(raw);
};
export const parseTargetTopologyAttestationRequest = (raw: unknown): TargetTopologyAttestationRequest => {
  assertOrdinaryJsonGraph(raw); return targetTopologyAttestationRequestSchema.parse(raw);
};
export const parseTargetTopologyReceipt = (raw: unknown): TargetTopologyReceipt => {
  assertOrdinaryJsonGraph(raw); return targetTopologyReceiptSchema.parse(raw);
};
