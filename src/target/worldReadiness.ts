import { createHash } from "node:crypto";

import { z } from "zod";

import {
  assertOrdinaryJsonGraph,
  opaqueTargetHandleSchema,
  runIdSchema,
  selectedTargetSchema
} from "./contracts.js";

export const TARGET_WORLD_READINESS_REQUEST_VERSION =
  "spawnfile.target-world-readiness.request.v1" as const;
export const TARGET_WORLD_READINESS_RECEIPT_VERSION =
  "spawnfile.target-world-readiness-receipt.v1" as const;
export const TARGET_WORLD_READINESS_PATH = "/v1/world/readiness" as const;
export const MAX_TARGET_WORLD_READINESS_BYTES = 32_768;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const protocolSchema = z.string().max(127)
  .regex(/^[a-z][a-z0-9._-]*\.v[1-9][0-9]*$/u);
const capabilityDigestsSchema = z.array(digestSchema).min(1).max(4_096)
  .superRefine((value, context) => {
    const sorted = [...new Set(value)].sort();
    if (sorted.length !== value.length
      || value.some((item, index) => item !== sorted[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "capability manifest digests must be sorted and unique"
      });
    }
  });
const capabilityIdentitiesSchema = z.array(z.object({
  identity: protocolSchema,
  manifest_digest: digestSchema
}).strict()).max(32).superRefine((value, context) => {
  const identities = value.map((entry) => entry.identity);
  if (new Set(identities).size !== identities.length
    || identities.some((item, index) => index > 0 && identities[index - 1]! >= item)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "capability identities must be sorted and unique"
    });
  }
});

export const targetWorldReadinessDocumentSchema = z.object({
  artifact_digest: digestSchema.nullable(),
  bundle_digest: digestSchema,
  capability_manifest_digests: capabilityDigestsSchema,
  capabilities: capabilityIdentitiesSchema.optional(),
  clock: z.object({ next_tick: z.literal(0), state: z.literal("paused") }).strict(),
  decisions: z.object({ count: z.literal(0), phase: z.literal("open") }).strict(),
  mechanics_sha256: digestSchema,
  normalized_checkpoint_sha256: digestSchema,
  run_id: runIdSchema,
  runtime_abi: protocolSchema,
  status: z.literal("ready"),
  version: protocolSchema,
  world_instance_id: runIdSchema
}).strict().superRefine((value, context) => {
  if (value.capabilities?.some((entry) =>
    !value.capability_manifest_digests.includes(entry.manifest_digest))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "capability identity manifest is not advertised"
    });
  }
});

const expectationSchema = z.object({
  artifact_digest: digestSchema.nullable(),
  bundle_digest: digestSchema,
  capability_manifest_digests: capabilityDigestsSchema,
  capabilities: capabilityIdentitiesSchema.optional(),
  document_version: protocolSchema,
  mechanics_sha256: digestSchema,
  normalized_checkpoint_sha256: digestSchema,
  runtime_abi: protocolSchema,
  world_instance_id: runIdSchema
}).strict();

export const targetWorldReadinessRequestSchema = z.object({
  descriptor_digest: digestSchema,
  endpoint: z.object({
    internal_port: z.number().int().min(1).max(65_535),
    path: z.literal(TARGET_WORLD_READINESS_PATH)
  }).strict(),
  expected: expectationSchema,
  run_id: runIdSchema,
  selected_target: selectedTargetSchema,
  version: z.literal(TARGET_WORLD_READINESS_REQUEST_VERSION),
  world_service_handle: opaqueTargetHandleSchema
}).strict();

export const targetWorldReadinessReceiptSchema = z.object({
  readiness: targetWorldReadinessDocumentSchema,
  readiness_digest: digestSchema,
  request_digest: digestSchema,
  run_id: runIdSchema,
  version: z.literal(TARGET_WORLD_READINESS_RECEIPT_VERSION)
}).strict();

export type TargetWorldReadinessDocument =
  z.infer<typeof targetWorldReadinessDocumentSchema>;
export type TargetWorldReadinessRequest =
  z.infer<typeof targetWorldReadinessRequestSchema>;
export type TargetWorldReadinessReceipt =
  z.infer<typeof targetWorldReadinessReceiptSchema>;

const canonicalValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const parse = <Value>(schema: z.ZodType<Value>, raw: unknown): Value => {
  assertOrdinaryJsonGraph(raw);
  return schema.parse(raw);
};
const hash = (domain: string, raw: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256")
    .update(`${domain}\0${canonicalValue(raw)}`, "utf8")
    .digest("hex")}`;

export const parseTargetWorldReadinessDocument = (
  raw: unknown
): TargetWorldReadinessDocument => parse(targetWorldReadinessDocumentSchema, raw);

export const parseTargetWorldReadinessRequest = (
  raw: unknown
): TargetWorldReadinessRequest => parse(targetWorldReadinessRequestSchema, raw);

export const parseTargetWorldReadinessReceipt = (
  raw: unknown
): TargetWorldReadinessReceipt => {
  const receipt = parse(targetWorldReadinessReceiptSchema, raw);
  if (receipt.readiness_digest !== hash(
    "spawnfile.target-world-readiness.document.v1",
    receipt.readiness
  )) throw new TypeError("Target world readiness receipt digest is invalid");
  return receipt;
};

export const createTargetWorldReadinessRequestDigest = (
  raw: unknown
): `sha256:${string}` => hash(
  TARGET_WORLD_READINESS_REQUEST_VERSION,
  parseTargetWorldReadinessRequest(raw)
);

const verifyDocument = (
  document: TargetWorldReadinessDocument,
  request: TargetWorldReadinessRequest
): void => {
  const expected = request.expected;
  if (document.version !== expected.document_version
    || document.runtime_abi !== expected.runtime_abi
    || document.run_id !== request.run_id
    || document.world_instance_id !== expected.world_instance_id
    || document.artifact_digest !== expected.artifact_digest
    || document.bundle_digest !== expected.bundle_digest
    || document.mechanics_sha256 !== expected.mechanics_sha256
    || document.normalized_checkpoint_sha256
      !== expected.normalized_checkpoint_sha256
    || canonicalValue(document.capability_manifest_digests)
      !== canonicalValue(expected.capability_manifest_digests)
    || canonicalValue(document.capabilities ?? [])
      !== canonicalValue(expected.capabilities ?? [])) {
    throw new TypeError("Target world readiness document correlation is invalid");
  }
};

export const createTargetWorldReadinessReceipt = (input: {
  readonly document: unknown;
  readonly request: unknown;
}): TargetWorldReadinessReceipt => {
  const request = parseTargetWorldReadinessRequest(input.request);
  const readiness = parseTargetWorldReadinessDocument(input.document);
  verifyDocument(readiness, request);
  return parseTargetWorldReadinessReceipt({
    readiness,
    readiness_digest: hash("spawnfile.target-world-readiness.document.v1", readiness),
    request_digest: createTargetWorldReadinessRequestDigest(request),
    run_id: request.run_id,
    version: TARGET_WORLD_READINESS_RECEIPT_VERSION
  });
};

export const verifyTargetWorldReadinessReceipt = (input: {
  readonly receipt: unknown;
  readonly request: unknown;
}): TargetWorldReadinessReceipt => {
  const receipt = parseTargetWorldReadinessReceipt(input.receipt);
  const expected = createTargetWorldReadinessReceipt({
    document: receipt.readiness,
    request: input.request
  });
  if (canonicalValue(receipt) !== canonicalValue(expected)) {
    throw new TypeError("Target world readiness receipt correlation is invalid");
  }
  return receipt;
};

export const createCanonicalTargetWorldReadinessReceiptBytes = (
  raw: unknown
): string => canonicalValue(parseTargetWorldReadinessReceipt(raw));
