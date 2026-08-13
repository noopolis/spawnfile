import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseCredentialProvisioningRequest } from "./credentialProvisioningRequest.js";
import type { CredentialProvisioningReceipt } from "./credentialProvisioningReceipt.js";
import {
  RESOLVED_WORLD_GRANTS_VERSION,
  buildProvisionedWorldBindings,
  parseResolvedWorldGrants
} from "./credentialWorldBindings.js";
import {
  TARGET_SECRET_SOURCE_ERROR,
  createCanonicalTargetSecretSourceJson
} from "./targetSecretSourceRecordCommon.js";

const request = () => parseCredentialProvisioningRequest({
  credentials: [
    { bytes: 16, env: "ALPHA_TOKEN", kind: "generated-token", name: "alpha-token" },
    { bytes: 16, env: "BETA_TOKEN", kind: "generated-token", name: "beta-token" }
  ],
  descriptor_digest: `sha256:${"a".repeat(64)}`,
  run_id: "run-1",
  scope: "world",
  selected_target: {
    fingerprint: `sha256:${"b".repeat(32)}`,
    handle: `opaque_${"c".repeat(16)}`,
    version: "spawnfile.target-resource.selected-target.v1"
  },
  version: "spawnfile.auth.credential-provisioning.request.v1",
  world_bindings: {
    json_url: "https://world.test/v1/world",
    mcp_url: "https://world.test/mcp",
    members: [
      { id: "alpha", principal_id: "agent:alpha", token_credential_name: "alpha-token" },
      { id: "beta", principal_id: "agent:beta", token_credential_name: "beta-token" }
    ],
    world_instance_id: "world-1"
  }
});
const receipt = (): CredentialProvisioningReceipt => ({
  credentials: [
    { env: "ALPHA_TOKEN", name: "alpha-token", scope: "world", source_handle: `opaque_${"d".repeat(16)}` as never },
    { env: "BETA_TOKEN", name: "beta-token", scope: "world", source_handle: `opaque_${"e".repeat(16)}` as never }
  ],
  phases: ["author", "grant"],
  run_id: "run-1",
  scope: "world",
  version: "spawnfile.auth.credential-provisioning.receipt.v1"
});
const resolved = () => ({
  grants: [
    { capability_manifest: { actions: ["observe"], limits: { rate: 1 } }, member_id: "alpha", principal_id: "agent:alpha" },
    { capability_manifest: { actions: ["act"], limits: { rate: 2 } }, member_id: "beta", principal_id: "agent:beta" }
  ],
  run_id: "run-1",
  version: RESOLVED_WORLD_GRANTS_VERSION,
  world_instance_id: "world-1"
});
const digest = (value: unknown): string => {
  const bytes = createCanonicalTargetSecretSourceJson(value);
  try { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
  finally { bytes.fill(0); }
};
const build = (raw: unknown) => buildProvisionedWorldBindings({
  receipt: receipt(),
  request: request(),
  resolved: raw
});
const reject = (raw: unknown) =>
  expect(() => build(raw)).toThrow(TARGET_SECRET_SOURCE_ERROR);

describe("provisioned world bindings", () => {
  it("hashes canonical resolved manifests without interpreting their contents", () => {
    const grants = resolved();
    const artifact = build(grants);
    expect(artifact.schema).toBe("simfile.world-bindings.v1");
    expect(artifact.bindings).toHaveLength(2);
    expect(artifact.bindings[0]).toMatchObject({
      capability_manifest_digest: digest(grants.grants[0]!.capability_manifest),
      member: { id: "alpha", principal_id: "agent:alpha" },
      token_env: "ALPHA_TOKEN"
    });
    expect(JSON.stringify(artifact)).not.toContain("actions");
  });

  it("rejects a caller-supplied capability digest", () => {
    const raw = resolved();
    (raw.grants[0] as Record<string, unknown>).capability_manifest_digest = `sha256:${"f".repeat(64)}`;
    reject(raw);
  });

  it("fails closed for missing and undeclared resolved members", () => {
    const missing = resolved();
    missing.grants.pop();
    reject(missing);
    const extra = resolved();
    extra.grants[1]!.member_id = "undeclared";
    extra.grants[1]!.principal_id = "agent:undeclared";
    reject(extra);
  });

  it("fails closed for run and world-instance disagreement", () => {
    reject({ ...resolved(), run_id: "run-2" });
    reject({ ...resolved(), world_instance_id: "world-2" });
  });

  it("rejects duplicate computed digests and principal disagreement", () => {
    const duplicate = resolved();
    duplicate.grants[1]!.capability_manifest = structuredClone(duplicate.grants[0]!.capability_manifest);
    reject(duplicate);
    const principal = resolved();
    principal.grants[0]!.principal_id = "agent:other";
    reject(principal);
  });

  it.each([
    null,
    [],
    {},
    { ...resolved(), version: "unsupported" },
    { ...resolved(), grants: [] },
    { ...resolved(), run_id: "" },
    { ...resolved(), world_instance_id: "" },
    { ...resolved(), grants: [{ ...resolved().grants[0], member_id: "" }] },
    { ...resolved(), grants: [{ ...resolved().grants[0], principal_id: "" }] },
    { ...resolved(), grants: [{ ...resolved().grants[0], extra: true }] },
  ])("rejects malformed resolved grant graphs %#", (raw) => {
    expect(() => parseResolvedWorldGrants(raw)).toThrow(TARGET_SECRET_SOURCE_ERROR);
  });

  it("rejects receipt and request correlation drift", () => {
    const currentRequest = request();
    const currentReceipt = receipt();
    const invoke = (
      requestValue: typeof currentRequest,
      receiptValue: CredentialProvisioningReceipt,
    ) => buildProvisionedWorldBindings({
      receipt: receiptValue,
      request: requestValue,
      resolved: resolved(),
    });
    expect(() => invoke(currentRequest, { ...currentReceipt, run_id: "other" }))
      .toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => invoke(currentRequest, { ...currentReceipt, scope: "deployment" }))
      .toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => invoke(currentRequest, {
      ...currentReceipt,
      credentials: currentReceipt.credentials.slice(1),
    })).toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(() => invoke(currentRequest, {
      ...currentReceipt,
      credentials: currentReceipt.credentials.map((credential, index) =>
        index === 0 ? { ...credential, env: "OTHER_TOKEN" } : credential),
    })).toThrow(TARGET_SECRET_SOURCE_ERROR);
  });
});
