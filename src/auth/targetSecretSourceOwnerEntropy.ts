import { createHash } from "node:crypto";

import {
  createCanonicalTargetSecretSourceJson,
  TARGET_SECRET_SOURCE_ERROR
} from "./targetSecretSourceRecordCommon.js";

export type TargetSecretSourceOwnerEntropyDomain =
  | "grant.publication_handle"
  | "redemption.publication_handle"
  | "revocation.revocation_handle"
  | "revocation.publication_handle";

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };

/**
 * Reconstructs lifecycle-record entropy solely from validated public semantics.
 * The domain prefix prevents any handle role from sharing the same hash input.
 */
export const deriveTargetSecretSourceOwnerEntropy = (
  domain: TargetSecretSourceOwnerEntropyDomain,
  publicMetadata: unknown
): Uint8Array => {
  let canonical: Uint8Array | undefined;
  let digest: Buffer | undefined;
  try {
    canonical = createCanonicalTargetSecretSourceJson(publicMetadata);
    digest = createHash("sha256")
      .update("spawnfile.auth.target-secret.owner-entropy.v1\0", "utf8")
      .update(domain, "utf8")
      .update("\0", "utf8")
      .update(canonical)
      .digest();
    return Uint8Array.from(digest.subarray(0, 16));
  } catch {
    return fail();
  } finally {
    canonical?.fill(0);
    digest?.fill(0);
  }
};
