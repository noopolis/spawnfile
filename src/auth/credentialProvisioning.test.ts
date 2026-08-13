import { describe, expect, it, vi } from "vitest";

import { parseCredentialProvisioningRequest } from "./credentialProvisioningRequest.js";
import {
  disposeProvisionedMaterials,
  provisionCredentials
} from "./credentialProvisioning.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";

const request = () => parseCredentialProvisioningRequest({
  credentials: [
    { bytes: 16, env: "FIRST_TOKEN", kind: "generated-token", name: "first-token" },
    { content: { z: 1, a: "DERIVED_SENTINEL" }, env: "CONFIG_JSON", kind: "derived-config", name: "config-json" }
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
const service = () => {
  let handleIndex = 0;
  const order: string[] = [];
  return {
    lifecycle: {
      author: vi.fn(async (material: Uint8Array) => {
        order.push(`author:${new TextDecoder().decode(material)}`);
        handleIndex += 1;
        return { source_handle: `opaque_${String(handleIndex).repeat(16)}` as never };
      }),
      grant: vi.fn(async (grant: { name: string; source_handle: string }) => {
        order.push(`grant:${grant.name}`);
        return { source_handle: grant.source_handle as never };
      })
    },
    order
  };
};

describe("batch credential provisioning", () => {
  it("authors all credentials then grants all credentials serially in one call", async () => {
    const fixture = service();
    const entropy = vi.fn((bytes: number) => new Uint8Array(bytes).fill(0xab));
    const result = await provisionCredentials(request(), { entropy, lifecycle: fixture.lifecycle });
    expect(entropy).toHaveBeenCalledWith(16);
    expect(fixture.order).toEqual([
      `author:${"ab".repeat(16)}`,
      'author:{"a":"DERIVED_SENTINEL","z":1}',
      "grant:first-token",
      "grant:config-json"
    ]);
    expect(result.receipt.credentials.map(({ name }) => name)).toEqual(["first-token", "config-json"]);
    expect(new TextDecoder().decode(result.materials.get("first-token"))).toBe("ab".repeat(16));
    expect(JSON.stringify(result.receipt)).not.toContain("DERIVED_SENTINEL");
    disposeProvisionedMaterials(result.materials);
    expect(result.materials.size).toBe(0);
  });

  it("zeroes every material and normalizes a failure partway through grants", async () => {
    const fixture = service();
    const seen: Uint8Array[] = [];
    fixture.lifecycle.author.mockImplementation(async (material) => {
      seen.push(material);
      return { source_handle: `opaque_${String(seen.length).repeat(16)}` as never };
    });
    fixture.lifecycle.grant
      .mockImplementationOnce(async (grant) => ({ source_handle: grant.source_handle as never }))
      .mockRejectedValueOnce(new Error("DERIVED_SENTINEL leaked detail"));
    await expect(provisionCredentials(request(), {
      entropy: (bytes) => new Uint8Array(bytes).fill(0xcd),
      lifecycle: fixture.lifecycle
    })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(seen).toHaveLength(2);
    expect(seen.every((material) => material.every((byte) => byte === 0))).toBe(true);
  });

  it("rejects malformed entropy without reflecting or retaining it", async () => {
    const fixture = service();
    const malformed = new TextEncoder().encode("ENTROPY_SENTINEL_WRONG_SIZE");
    await expect(provisionCredentials(request(), {
      entropy: () => malformed,
      lifecycle: fixture.lifecycle
    })).rejects.toThrow(TARGET_SECRET_SOURCE_ERROR);
    expect(malformed.every((byte) => byte === 0)).toBe(true);
    expect(fixture.lifecycle.author).not.toHaveBeenCalled();
  });
});
