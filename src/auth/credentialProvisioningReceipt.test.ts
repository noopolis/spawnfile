import { describe, expect, it } from "vitest";

import { parseCredentialProvisioningRequest } from "./credentialProvisioningRequest.js";
import {
  CREDENTIAL_PROVISIONING_RECEIPT_VERSION,
  createCredentialProvisioningReceipt,
  finalizeCredentialProvisioningReceipt
} from "./credentialProvisioningReceipt.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";

const request = () => parseCredentialProvisioningRequest({
  credentials: [
    { bytes: 16, env: "FIRST_TOKEN", kind: "generated-token", name: "first-token" },
    { content: { endpoint: "https://service.test" }, env: "CONFIG_JSON", kind: "derived-config", name: "config-json" }
  ],
  descriptor_digest: `sha256:${"a".repeat(64)}`,
  run_id: "run-1",
  scope: "world",
  selected_target: {
    fingerprint: `sha256:${"b".repeat(32)}`,
    handle: `opaque_${"c".repeat(16)}`,
    version: "spawnfile.target-resource.selected-target.v1"
  },
  version: "spawnfile.auth.credential-provisioning.request.v1"
});
const handles = () => new Map<string, unknown>([
  ["first-token", `opaque_${"d".repeat(16)}`],
  ["config-json", `opaque_${"e".repeat(16)}`]
]);

describe("credential provisioning receipt", () => {
  it("projects only allowlisted public fields", () => {
    const receipt = createCredentialProvisioningReceipt({ request: request(), source_handles: handles() });
    expect(Object.keys(receipt).sort()).toEqual(["credentials", "phases", "run_id", "scope", "version"]);
    expect(Object.keys(receipt.credentials[0]!).sort()).toEqual(["env", "name", "scope", "source_handle"]);
    expect(receipt).toMatchObject({
      phases: ["author", "grant"],
      version: CREDENTIAL_PROVISIONING_RECEIPT_VERSION
    });
    const text = JSON.stringify(receipt);
    expect(text).not.toMatch(/source.?version/iu);
    expect(text).not.toMatch(/material|endpoint/iu);
  });

  it("adds ordered phase names and only produced digests", () => {
    const receipt = createCredentialProvisioningReceipt({ request: request(), source_handles: handles() });
    const finalized = finalizeCredentialProvisioningReceipt(receipt, {
      env_file_digest: `sha256:${"1".repeat(64)}`,
      model_engine_auth: true,
      world_bindings_digest: `sha256:${"2".repeat(64)}`
    });
    expect(finalized.phases).toEqual([
      "author", "grant", "model_engine_auth", "env_file", "world_bindings"
    ]);
    expect(Object.keys(finalized).sort()).toEqual([
      "credentials", "env_file_digest", "phases", "run_id", "scope", "version", "world_bindings_digest"
    ]);
  });

  it("fails closed on missing handles and malformed output digests", () => {
    expect(() => createCredentialProvisioningReceipt({
      request: request(),
      source_handles: new Map([["first-token", `opaque_${"d".repeat(16)}`]])
    })).toThrow(TARGET_SECRET_SOURCE_ERROR);
    const receipt = createCredentialProvisioningReceipt({ request: request(), source_handles: handles() });
    expect(() => finalizeCredentialProvisioningReceipt(receipt, {
      env_file_digest: "sha256:short"
    })).toThrow(TARGET_SECRET_SOURCE_ERROR);
  });
});
