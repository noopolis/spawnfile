import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createOrganizationHandoff,
  parseCanonicalSha256Digest
} from "../deployment/organizationHandoffTypes.js";
import { parseOpaqueTargetHandle } from "./contracts.js";
import {
  createOrganizationAttachmentAuthorization,
  parseOrganizationAttachmentAuthorization,
  parseOrganizationAttachmentResolution,
  parseResolvedOrganizationHandoff,
  type OrganizationAttachmentAuthorization
} from "./organizationAttachmentAuthority.js";

const selected = {
  fingerprint: `sha256:${"1".repeat(32)}`,
  handle: parseOpaqueTargetHandle("opaque_0123456789abcdef")
};
const handoff = createOrganizationHandoff("run-attachment", {
  bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
  networkAttachmentHandle: parseOpaqueTargetHandle("opaque_abcdefghijklmnop"),
  selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"a".repeat(64)}`)
});
const labels = {
  "com.spawnfile.compile_fingerprint": "sf1:compile",
  "com.spawnfile.deployment": "football",
  "com.spawnfile.project": "test-project",
  "com.spawnfile.run_id": "run-attachment",
  "com.spawnfile.unit": "football-container",
  "com.spawnfile.version": "0.1"
};
const authorization = (): OrganizationAttachmentAuthorization =>
  createOrganizationAttachmentAuthorization({
    descriptorDigest: `sha256:${"d".repeat(64)}`,
    operationHandle: "opaque_1111111111111111",
    organizationHandoffHandle: "opaque_2222222222222222",
    requestDigest: `sha256:${"e".repeat(64)}`,
    runId: "run-attachment",
    selectedTarget: selected
  });
const resolution = (auth = authorization()) => ({
  authorization: auth,
  descriptor_binding: {
    binding_digest: handoff.binding_digest,
    descriptor_digest: auth.descriptor_digest
  },
  handoff,
  network_attachment: {
    container_id: "c".repeat(64),
    deployment_labels: labels,
    network_attachment_handle: handoff.network_attachment_handle
  },
  selected_target_binding: {
    receipt: { ...selected, version: "spawnfile.target-resource.selected-target.v1" },
    receipt_digest: handoff.selected_target_receipt_digest
  }
});

describe("organization attachment authority", () => {
  it("parses the landed H1 handoff independently with identical canonical bytes", () => {
    const parsed = parseResolvedOrganizationHandoff(handoff);
    expect(parsed).toEqual(handoff);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(handoff));
    expect(parseOrganizationAttachmentResolution(resolution())).toEqual(resolution());
  });

  it("binds one exact request claim to its opaque handoff resolver call", () => {
    const value = authorization();
    expect(parseOrganizationAttachmentAuthorization(value)).toEqual(value);
    expect(Object.keys(value).sort()).toEqual([
      "descriptor_digest", "operation_handle", "organization_handoff_handle",
      "request_digest", "run_id", "selected_target", "version"
    ]);
  });

  it("rejects malformed authorization and handoff authority fields", () => {
    expect(() => createOrganizationAttachmentAuthorization({
      descriptorDigest: "sha256:nope",
      operationHandle: "opaque_1111111111111111",
      organizationHandoffHandle: "opaque_2222222222222222",
      requestDigest: `sha256:${"e".repeat(64)}`,
      runId: "run-attachment",
      selectedTarget: null
    })).toThrow();
    expect(() => createOrganizationAttachmentAuthorization({
      descriptorDigest: "sha256:nope",
      operationHandle: "opaque_1111111111111111",
      organizationHandoffHandle: "opaque_2222222222222222",
      requestDigest: `sha256:${"e".repeat(64)}`,
      runId: "run-attachment",
      selectedTarget: selected
    })).toThrow("Docker organization attachment failed");
    expect(() => parseOrganizationAttachmentAuthorization({
      ...authorization(),
      selected_target: { ...authorization().selected_target, fingerprint: "sha256:nope" }
    })).toThrow("Docker organization attachment failed");
    expect(() => parseResolvedOrganizationHandoff({
      ...handoff,
      lifecycle_receipts: { ...handoff.lifecycle_receipts, up: "v2" }
    })).toThrow("Docker organization attachment failed");
  });

  it("rejects every cross-authority resolution mismatch", () => {
    const base = resolution();
    const mutations: unknown[] = [
      { ...base, descriptor_binding: { ...base.descriptor_binding, descriptor_digest: `sha256:${"0".repeat(64)}` } },
      { ...base, descriptor_binding: { ...base.descriptor_binding, binding_digest: `sha256:${"0".repeat(64)}` } },
      { ...base, handoff: { ...base.handoff, run_id: "other-run" } },
      { ...base, handoff: { ...base.handoff, deployment_handle: `sf-oh1-${"0".repeat(64)}` } },
      { ...base, network_attachment: { ...base.network_attachment, network_attachment_handle: "opaque_3333333333333333" } },
      { ...base, network_attachment: { ...base.network_attachment, container_id: "short" } },
      { ...base, network_attachment: { ...base.network_attachment,
        deployment_labels: { ...labels, "com.spawnfile.run_id": "other-run" } } },
      { ...base, selected_target_binding: { ...base.selected_target_binding,
        receipt_digest: `sha256:${"0".repeat(64)}` } },
      { ...base, selected_target_binding: { ...base.selected_target_binding,
        receipt: { ...base.selected_target_binding.receipt, handle: "opaque_3333333333333333" } } },
      { ...base, extra: true }
    ];
    for (const mutation of mutations) {
      expect(() => parseOrganizationAttachmentResolution(mutation)).toThrow(
        "Docker organization attachment failed"
      );
    }
  });

  it("rejects hostile graphs without reflecting private values", () => {
    const hostile = "secret-token-private-container";
    const cyclic = resolution() as ReturnType<typeof resolution> & { self?: unknown };
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({ ...resolution() }, "handoff", {
      enumerable: true,
      get: () => { throw new Error(hostile); }
    });
    for (const invalid of [new Proxy(resolution(), {}), cyclic, accessor,
      { ...resolution(), [hostile]: hostile }]) {
      let message = "";
      try { parseOrganizationAttachmentResolution(invalid); }
      catch (error) { message = String(error); }
      expect(message).toContain("Docker organization attachment failed");
      expect(message).not.toContain(hostile);
    }
  });

  it("keeps deployment compatibility one-way and out of production target code", async () => {
    for (const file of [
      "organizationAttachment.ts", "organizationAttachmentAuthority.ts",
      "organizationAttachmentProvider.ts", "organizationAttachmentStore.ts"
    ]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/(?:\.\.\/deployment|organizationHandoffTypes)/u);
    }
    const barrel = await readFile(new URL("index.ts", import.meta.url), "utf8");
    expect(barrel).not.toMatch(/organizationAttachment/u);
  });
});
