import {
  createCanonicalTargetReceiptBytes,
  createTargetReceiptDigest
} from "../target/handles.js";
import {
  parseTargetResourceReceipt,
  type TargetResourceReceipt
} from "../target/contracts.js";
import { isSpawnfileError } from "../shared/index.js";

export interface TargetMutationResult {
  readonly receipt: unknown;
  readonly receiptBytes: unknown;
}

export interface CanonicalTargetMutationReceipt {
  readonly bytes: string;
  readonly receipt: TargetResourceReceipt;
}

export type TargetCliErrorPhase = "operation" | "request";

export const formatTargetCliError = (phase: TargetCliErrorPhase): string =>
  phase === "request" ? "error: Invalid target request" : "error: Target operation failed";

export const formatCaughtTargetCliError = (
  error: unknown,
  crashMessage: string
): string => isSpawnfileError(error)
  ? `error: ${error.message}`
  : `error: ${crashMessage}`;

export const validateCanonicalTargetMutationReceipt = (
  raw: TargetMutationResult
): CanonicalTargetMutationReceipt => {
  const receipt = parseTargetResourceReceipt(raw.receipt);
  const bytes = createCanonicalTargetReceiptBytes(receipt);
  if (receipt.receipt_digest !== createTargetReceiptDigest(receipt)
    || typeof raw.receiptBytes !== "string" || raw.receiptBytes !== bytes) {
    throw new TypeError("Target operation returned a non-canonical receipt");
  }
  return Object.freeze({ bytes, receipt });
};

export const emitCanonicalTargetMutationReceipt = (
  raw: TargetMutationResult,
  write: (receiptBytes: string) => void
): TargetResourceReceipt => {
  const validated = validateCanonicalTargetMutationReceipt(raw);
  write(validated.bytes);
  return validated.receipt;
};
