import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

import { assertOrdinaryJsonGraph, opaqueTargetHandleSchema, selectedTargetSchema } from "./contracts.js";

export const TARGET_LOCAL_BUNDLE_PREPARE_REQUEST_VERSION =
  "spawnfile.target-local-container-bundle.prepare-request.v1" as const;
export const TARGET_LOCAL_BUNDLE_PREPARE_RECEIPT_VERSION =
  "spawnfile.target-local-container-bundle.prepare-receipt.v1" as const;
export const TARGET_LOCAL_BUNDLE_LOOKUP_VERSION =
  "spawnfile.target-local-container-bundle.lookup.v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const idempotency = z.string().regex(/^idem_[a-z0-9]{16,64}$/u);
const alias = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);
const archivePath = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u)
  .refine((value) => !value.includes("//") && !value.split("/").some((part) => part === "." || part === ".."))
  .refine((value) => {
    if (Buffer.byteLength(value, "utf8") <= 100) return true;
    const split = value.lastIndexOf("/");
    return split > 0 && Buffer.byteLength(value.slice(0, split), "utf8") <= 155
      && Buffer.byteLength(value.slice(split + 1), "utf8") <= 100;
  });
const platform = z.object({ architecture: z.enum(["amd64", "arm64"]), os: z.literal("linux") }).strict();
const canonicalBase64 = (value: string): boolean => {
  if (value.length > 5_592_408 || value.length % 4 !== 0) return false;
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index); const equals = code === 61;
    const ordinary = code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47;
    if (!equals && !ordinary || equals && index < value.length - 2) return false;
    if (equals) padding += 1; else if (padding > 0) return false;
  }
  if (padding > 2 || padding === 1 && value.at(-1) !== "=" || padding === 2 && !value.endsWith("==")) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= 4_194_304 && bytes.toString("base64") === value;
};
const archiveBytes = z.string().refine(canonicalBase64);
const canonicalEntries = (items: readonly string[]): boolean => items.every((item, index) =>
  (index === 0 || items[index - 1]! < item) && archivePath.safeParse(item).success);

export const targetLocalBundlePrepareRequestSchema = z.object({
  archive_base64: archiveBytes,
  archive_digest: digest,
  archive_entries: z.array(archivePath).min(1).max(32).superRefine((items, context) => {
    if (!canonicalEntries(items)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "archive entries must be canonical" });
    }
  }),
  artifact_digest: digest,
  build_policy_digest: digest,
  bundle_digest: digest,
  entrypoint: archivePath,
  idempotency_key: idempotency,
  launcher_digest: digest,
  network_alias: alias,
  platform,
  platform_digest: digest,
  selected_target: selectedTargetSchema,
  version: z.literal(TARGET_LOCAL_BUNDLE_PREPARE_REQUEST_VERSION)
}).strict().superRefine((value, context) => {
  if (new Set([value.archive_digest, value.artifact_digest, value.build_policy_digest,
    value.bundle_digest, value.launcher_digest, value.platform_digest]).size !== 6) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "bundle correlations must be distinct" });
  }
  if (!value.archive_entries.includes(value.entrypoint)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "entrypoint must be an admitted archive entry" });
  }
});

const receiptBodySchema = z.object({
  archive_digest: digest,
  artifact_digest: digest,
  build_policy_digest: digest,
  bundle_digest: digest,
  launcher_digest: digest,
  mapping_handle: opaqueTargetHandleSchema,
  network_alias: alias,
  operation_handle: opaqueTargetHandleSchema,
  platform,
  platform_digest: digest,
  receipt_digest: digest,
  request_digest: digest,
  selected_target: selectedTargetSchema,
  version: z.literal(TARGET_LOCAL_BUNDLE_PREPARE_RECEIPT_VERSION)
}).strict();
export const targetLocalBundlePrepareReceiptSchema = receiptBodySchema;

const lookupBase = {
  idempotency_key: idempotency,
  request_digest: digest,
  version: z.literal(TARGET_LOCAL_BUNDLE_LOOKUP_VERSION)
};
export const targetLocalBundleLookupSchema = z.discriminatedUnion("status", [
  z.object({ ...lookupBase, status: z.literal("not_applied") }).strict(),
  z.object({ ...lookupBase, operation_handle: opaqueTargetHandleSchema, status: z.literal("pending") }).strict(),
  z.object({ ...lookupBase, operation_handle: opaqueTargetHandleSchema, receipt: receiptBodySchema, status: z.literal("completed") }).strict()
]);
export const targetLocalBundleLookupRequestSchema = z.object({
  idempotency_key: idempotency,
  request_digest: digest,
  version: z.literal(TARGET_LOCAL_BUNDLE_LOOKUP_VERSION)
}).strict();

export type TargetLocalBundlePrepareRequest = z.infer<typeof targetLocalBundlePrepareRequestSchema>;
export type TargetLocalBundlePrepareReceipt = z.infer<typeof targetLocalBundlePrepareReceiptSchema>;
export type TargetLocalBundleLookup = z.infer<typeof targetLocalBundleLookupSchema>;
export type TargetLocalBundleLookupRequest = z.infer<typeof targetLocalBundleLookupRequestSchema>;

/* The generic JSON graph guard intentionally caps ordinary control messages at
 * 64 KiB. A bundle request is the one bounded binary envelope: its canonical
 * base64 may be 5,592,408 bytes for a 4 MiB archive. Clone descriptor values
 * first, replacing only that field for graph admission, so schema parsing
 * never invokes caller-owned accessors or proxies. */
const safeBundleRequestGraph = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    assertOrdinaryJsonGraph(raw); return raw;
  }
  const prototype = Object.getPrototypeOf(raw); const descriptors = Object.getOwnPropertyDescriptors(raw);
  const archive = descriptors.archive_base64;
  if (prototype !== Object.prototype || !archive || !("value" in archive) || typeof archive.value !== "string") {
    assertOrdinaryJsonGraph(raw); return raw;
  }
  const admitted = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperties(admitted, descriptors);
  Object.defineProperty(admitted, "archive_base64", { configurable: true, enumerable: true, value: "", writable: true });
  assertOrdinaryJsonGraph(admitted);
  Object.defineProperty(admitted, "archive_base64", { configurable: true, enumerable: true, value: archive.value, writable: true });
  return admitted;
};
export const parseTargetLocalBundlePrepareRequest = (raw: unknown): TargetLocalBundlePrepareRequest => {
  return targetLocalBundlePrepareRequestSchema.parse(safeBundleRequestGraph(raw));
};
export const parseTargetLocalBundlePrepareReceipt = (raw: unknown): TargetLocalBundlePrepareReceipt => {
  assertOrdinaryJsonGraph(raw);
  const parsed = targetLocalBundlePrepareReceiptSchema.parse(raw);
  if (parsed.receipt_digest !== createTargetLocalBundleReceiptDigest(parsed)) throw new Error("Container bundle receipt failed");
  return parsed;
};
export const parseTargetLocalBundleLookup = (raw: unknown): TargetLocalBundleLookup => {
  assertOrdinaryJsonGraph(raw);
  const parsed = targetLocalBundleLookupSchema.parse(raw);
  if (parsed.status === "completed") {
    const receipt = parseTargetLocalBundlePrepareReceipt(parsed.receipt);
    if (receipt.operation_handle !== parsed.operation_handle || receipt.request_digest !== parsed.request_digest) {
      throw new Error("Container bundle lookup failed");
    }
  }
  return parsed;
};
export const parseTargetLocalBundleLookupRequest = (raw: unknown): TargetLocalBundleLookupRequest => {
  assertOrdinaryJsonGraph(raw); return targetLocalBundleLookupRequestSchema.parse(raw);
};

const canonical = (value: unknown, trusted = false): string => {
  if (!trusted) assertOrdinaryJsonGraph(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, true)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], true)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const hashed = (domain: string, value: unknown, trusted = false): `sha256:${string}` => `sha256:${createHash("sha256")
  .update(`spawnfile.target-local-container-bundle.${domain}.v1\0`, "utf8")
  .update(canonical(value, trusted), "utf8").digest("hex")}`;
export const createTargetLocalBundleRequestDigest = (raw: unknown): `sha256:${string}` =>
  hashed("request", parseTargetLocalBundlePrepareRequest(raw), true);
export const createTargetLocalBundleReceiptDigest = (raw: unknown): `sha256:${string}` => {
  assertOrdinaryJsonGraph(raw);
  const { receipt_digest: _digest, ...body } = targetLocalBundlePrepareReceiptSchema.parse(raw);
  return hashed("receipt", body);
};
export const createCanonicalTargetLocalBundleReceiptBytes = (raw: unknown): string =>
  canonical(parseTargetLocalBundlePrepareReceipt(raw));
export const createCanonicalTargetLocalBundleLookupBytes = (raw: unknown): string => canonical(parseTargetLocalBundleLookup(raw));
