import { describe, expect, it, vi } from "vitest";

import {
  createCanonicalTargetReceiptBytes,
  createTargetReceiptDigest
} from "../target/index.js";
import {
  emitCanonicalTargetMutationReceipt,
  formatTargetCliError,
  validateCanonicalTargetMutationReceipt
} from "./targetReceiptOutput.js";

const digest = `sha256:${"a".repeat(64)}`;
const receiptBody = {
  cleanup_state: "not_requested",
  descriptor_digest: digest,
  export_state: "not_requested",
  labels: [],
  operation: "create_data_network",
  operation_handle: "opaque_aaaaaaaaaaaaaaaa",
  request_digest: digest,
  result_handle: "opaque_bbbbbbbbbbbbbbbb",
  resulting_revision: 1,
  run_id: "run-one",
  selected_target: {
    fingerprint: `sha256:${"c".repeat(32)}`,
    handle: "opaque_cccccccccccccccc"
  },
  version: "spawnfile.target-resource.receipt.v1"
} as const;
const receipt = {
  ...receiptBody,
  receipt_digest: createTargetReceiptDigest({ ...receiptBody, receipt_digest: digest })
};
const receiptBytes = createCanonicalTargetReceiptBytes(receipt);

describe("canonical target mutation receipt output", () => {
  it("emits only the exact canonical receipt bytes", () => {
    const write = vi.fn();
    expect(emitCanonicalTargetMutationReceipt({ receipt, receiptBytes }, write)).toEqual(receipt);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(receiptBytes);

    const processWrites: string[] = [];
    emitCanonicalTargetMutationReceipt(
      { receipt, receiptBytes },
      (line) => processWrites.push(`${line}\n`)
    );
    expect(processWrites).toEqual([`${receiptBytes}\n`]);
  });

  it("rejects mismatched, pretty, or malformed receipt output without writing", () => {
    for (const result of [
      { receipt, receiptBytes: `${receiptBytes}\n` },
      { receipt, receiptBytes: JSON.stringify(receipt, null, 2) },
      { receipt: { ...receipt, private_provider_id: "secret" }, receiptBytes }
    ]) {
      expect(() => validateCanonicalTargetMutationReceipt(result)).toThrow();
    }
  });

  it("rejects a canonical receipt whose embedded digest is false without writing", () => {
    const write = vi.fn();
    const falseReceipt = {
      ...receipt,
      receipt_digest: `sha256:${"b".repeat(64)}`
    };
    const falseBytes = createCanonicalTargetReceiptBytes(falseReceipt);
    expect(() => emitCanonicalTargetMutationReceipt({
      receipt: falseReceipt,
      receiptBytes: falseBytes
    }, write)).toThrow("non-canonical receipt");
    expect(write).not.toHaveBeenCalled();
  });

  it("provides bounded phase-only errors without reflecting private failures", () => {
    expect(formatTargetCliError("request")).toBe("error: Invalid target request");
    expect(formatTargetCliError("operation")).toBe("error: Target operation failed");
    expect(formatTargetCliError("operation")).not.toContain("docker");
  });
});
