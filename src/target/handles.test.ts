import { describe, expect, it } from "vitest";

import { TARGET_RESOURCE_RECEIPT_VERSION, TARGET_RESOURCE_REQUEST_VERSION } from "./contracts.js";
import { createCanonicalSelectedTargetReceiptBytes, createCanonicalTargetReceiptBytes, createPendingReceiptDigest, createTargetJournalIdentity, createTargetOperationHandle, createTargetReceiptDigest, createTargetRequestDigest } from "./handles.js";

const digest = `sha256:${"a".repeat(64)}`;
const target = { fingerprint: `sha256:${"b".repeat(32)}`, handle: `opaque_${"c".repeat(16)}` };
const selected = { ...target, version: "spawnfile.target-resource.selected-target.v1" };
const request = { descriptor_digest: digest, expected_revision: 0, idempotency_key: `idem_${"d".repeat(16)}`, operation: "create_data_network", run_id: "run-one", selected_target: target, version: TARGET_RESOURCE_REQUEST_VERSION };
const receipt = { cleanup_state: "not_requested", descriptor_digest: digest, export_state: "not_requested", labels: [], operation: "create_data_network", operation_handle: `opaque_${"e".repeat(16)}`, receipt_digest: digest, request_digest: digest, result_handle: null, resulting_revision: 1, run_id: "run-one", selected_target: target, version: TARGET_RESOURCE_RECEIPT_VERSION };

describe("target handle authority", () => {
  it("is deterministic, canonical, domain-separated, and T1-shaped", () => {
    expect(createTargetRequestDigest(request)).toBe(createTargetRequestDigest({ ...request, selected_target: { ...target } }));
    expect(createTargetRequestDigest(request)).not.toBe(createTargetReceiptDigest(receipt));
    expect(createTargetOperationHandle(`sha256:${"f".repeat(64)}`, request)).toMatch(/^opaque_[a-z0-9]{64}$/);
    expect(createCanonicalTargetReceiptBytes({ ...receipt, labels: [] })).toContain('"operation":"create_data_network"');
    expect(createCanonicalSelectedTargetReceiptBytes(selected)).toBe(
      `{"fingerprint":"sha256:${"b".repeat(32)}","handle":"opaque_${"c".repeat(16)}","version":"spawnfile.target-resource.selected-target.v1"}`
    );
    expect(createPendingReceiptDigest(receipt.operation_handle, digest)).not.toBe(createTargetReceiptDigest(receipt));
  });

  it("runtime-parses every exported identity input", () => {
    const identity = { context: "production", descriptor_digest: digest, run_id: "run-one", selected_target: selected };
    expect(createTargetJournalIdentity(identity)).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const bad of [
      () => createTargetJournalIdentity({ ...identity, context: "bad context" }),
      () => createTargetJournalIdentity({ ...identity, descriptor_digest: "sha256:BAD" }),
      () => createTargetJournalIdentity({ ...identity, run_id: "run/id" }),
      () => createTargetJournalIdentity({ ...identity, selected_target: { ...selected, fingerprint: "bad" } }),
      () => createTargetOperationHandle("sha256:BAD" as never, request),
      () => createTargetOperationHandle(digest as `sha256:${string}`, { ...request, run_id: "run/id" }),
      () => createPendingReceiptDigest("opaque_short", digest),
      () => createPendingReceiptDigest(receipt.operation_handle, "sha256:BAD"),
      () => createCanonicalSelectedTargetReceiptBytes({ ...selected, endpoint: "private" })
    ]) expect(bad).toThrow();
  });

  it("rejects hostile and unbounded request or receipt graphs", () => {
    expect(() => createTargetRequestDigest({ ...request, context: "secret" })).toThrow();
    expect(() => createTargetRequestDigest({ ...request, run_id: "x".repeat(129) })).toThrow();
    expect(() => createTargetReceiptDigest({ ...receipt, endpoint: "secret" })).toThrow();
    expect(() => createTargetRequestDigest(Object.assign(Object.create({}), request))).toThrow();
  });
});
