import { createHash } from "node:crypto";

import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseRunId,
  parseSelectedTargetReceipt,
  parseTargetOperationLookup,
  parseTargetResourceJournal,
  parseTargetResourceReceipt,
  parseTargetResourceRequest,
  parseTargetTopologyAttestationRequest,
  parseTargetTopologyReceipt,
  TARGET_JOURNAL_VERSION,
  type OpaqueTargetHandle,
  type SelectedTargetReceipt,
  type TargetOperationLookup, type TargetResourceReceipt,
  type TargetResourceRequest,
  type TargetTopologyReceipt
} from "./contracts.js";

export type TargetDigest = `sha256:${string}`;
export type TargetDigestDomain = "journal-identity" | "operation-handle" | "pending-receipt" | "receipt" | "request";

const canonicalJson = (value: unknown): string => {
  assertOrdinaryJsonGraph(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const createCanonicalTargetDigest = (domain: TargetDigestDomain, value: unknown): TargetDigest => `sha256:${createHash("sha256")
  .update(`spawnfile.target-resource.${domain}.v1\0`, "utf8").update(canonicalJson(value), "utf8").digest("hex")}`;

/* T1 owns the digest grammar; this surrogate parses one through its journal field. */
const parseTargetDigest = (raw: unknown): TargetDigest => parseTargetResourceJournal({
  descriptor_digest: raw, entries: [], revision: 0, run_id: "a",
  selected_target: { fingerprint: `sha256:${"0".repeat(32)}`, handle: "opaque_0000000000000000" },
  version: TARGET_JOURNAL_VERSION
}).descriptor_digest as TargetDigest;

const parseContext = (raw: unknown): string => {
  if (typeof raw !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(raw)) throw new TypeError("invalid target journal context");
  return raw;
};

export const createTargetRequestDigest = (raw: unknown): TargetDigest =>
  createCanonicalTargetDigest("request", parseTargetResourceRequest(raw));

export const createTargetReceiptDigest = (raw: unknown): TargetDigest => {
  const receipt = parseTargetResourceReceipt(raw);
  const { receipt_digest: _receiptDigest, ...body } = receipt;
  return createCanonicalTargetDigest("receipt", body);
};

export const createTargetOperationHandle = (journalIdentity: TargetDigest, rawRequest: unknown): OpaqueTargetHandle => {
  const request = parseTargetResourceRequest(rawRequest);
  const identity = parseTargetDigest(journalIdentity);
  return parseOpaqueTargetHandle(`opaque_${createCanonicalTargetDigest("operation-handle", { journal_identity: identity, request }).slice("sha256:".length)}`);
};

export const createCanonicalTargetReceiptBytes = (raw: unknown): string => canonicalJson(parseTargetResourceReceipt(raw));
export const createCanonicalSelectedTargetReceiptBytes = (raw: unknown): string =>
  canonicalJson(parseSelectedTargetReceipt(raw));
export const createCanonicalTargetOperationLookupBytes = (raw: unknown): string =>
  canonicalJson(parseTargetOperationLookup(raw));

const createTopologyDigest = (domain: "receipt" | "request", value: unknown): TargetDigest =>
  `sha256:${createHash("sha256")
    .update(`spawnfile.target-topology-${domain}.v1\0`, "utf8")
    .update(canonicalJson(value), "utf8").digest("hex")}`;

export const createTargetTopologyAttestationRequestDigest = (raw: unknown): TargetDigest =>
  createTopologyDigest("request", parseTargetTopologyAttestationRequest(raw));

export const createTargetTopologyReceiptDigest = (raw: unknown): TargetDigest => {
  const receipt = parseTargetTopologyReceipt(raw);
  const { receipt_digest: _receiptDigest, ...body } = receipt;
  return createTopologyDigest("receipt", body);
};

export const createCanonicalTargetTopologyReceiptBytes = (raw: unknown): string =>
  canonicalJson(parseTargetTopologyReceipt(raw));

export const createTargetJournalIdentity = (input: {
  context: unknown;
  descriptor_digest: unknown;
  run_id: unknown;
  selected_target: unknown;
}): TargetDigest => createCanonicalTargetDigest("journal-identity", {
  context: parseContext(input.context), descriptor_digest: parseTargetDigest(input.descriptor_digest),
  run_id: parseRunId(input.run_id), selected_target: parseSelectedTargetReceipt(input.selected_target)
});

export const createPendingReceiptDigest = (operationHandle: unknown, requestDigest: unknown): TargetDigest =>
  createCanonicalTargetDigest("pending-receipt", {
    operation_handle: parseOpaqueTargetHandle(operationHandle), request_digest: parseTargetDigest(requestDigest)
  });

export type { OpaqueTargetHandle, SelectedTargetReceipt, TargetResourceReceipt, TargetResourceRequest, TargetTopologyReceipt };
