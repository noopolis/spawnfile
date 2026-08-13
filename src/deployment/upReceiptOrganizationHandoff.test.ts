import { describe, expect, it } from "vitest";

import {
  createOrganizationDeploymentHandle,
  createOrganizationHandoff,
  parseCanonicalSha256Digest
} from "./organizationHandoffTypes.js";
import { parseOpaqueTargetHandle } from "../target/index.js";
import { parseUpReceipt, upReceiptSchema, UP_RECEIPT_VERSION } from "./upReceiptTypes.js";

const handoff = createOrganizationHandoff("run-from-host", {
  bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
  networkAttachmentHandle: parseOpaqueTargetHandle("opaque_0123456789abcdef"),
  selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"a".repeat(64)}`)
});
const handoffHandle = `opaque_${"f".repeat(64)}`;

const receipt = () => ({
  compiled_schedule: [], deployment: { container_ids: ["container-opaque"], name: "football" },
  fingerprint: "sf1:0123456789ab", readiness: { moltnet_base_url: null, state: "running" as const },
  run_id: "run-from-host", version: UP_RECEIPT_VERSION, organization_handoff: handoff
});

describe("up receipt organization handoff", () => {
  it("reads the strict H1 artifact exactly and leaves absent receipt bytes unchanged", () => {
    expect(parseUpReceipt({ ...receipt(), organization_handoff_handle: handoffHandle })).toMatchObject({ organization_handoff: handoff, organization_handoff_handle: handoffHandle });
    const absent = { ...receipt() };
    delete (absent as { organization_handoff?: unknown }).organization_handoff;
    expect(parseUpReceipt(absent)).not.toHaveProperty("organization_handoff");
    expect(() => parseUpReceipt({ ...absent, organization_handoff_handle: handoffHandle })).toThrow(`invalid ${UP_RECEIPT_VERSION}`);
  });

  it("makes the exported schema enforce handoff semantics and receipt correlation", () => {
    expect(upReceiptSchema.safeParse(receipt()).success).toBe(true);

    const forgedHandle = { ...receipt(), organization_handoff: {
      ...handoff, deployment_handle: `sf-oh1-${"0".repeat(64)}`
    }};
    const overlongRunId = "r".repeat(129);
    const overlongHandoffInput = { ...handoff, run_id: overlongRunId as typeof handoff.run_id };
    const overlongHandle = createOrganizationDeploymentHandle(overlongHandoffInput);
    const overlong = { ...receipt(), run_id: overlongRunId, organization_handoff: {
      ...overlongHandoffInput, deployment_handle: overlongHandle
    }};
    const otherRunHandoff = createOrganizationHandoff("run-other", {
      bindingDigest: parseCanonicalSha256Digest(`sha256:${"c".repeat(64)}`),
      networkAttachmentHandle: parseOpaqueTargetHandle("opaque_abcdefghijklmnop"),
      selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"d".repeat(64)}`)
    });
    const crossRun = { ...receipt(), organization_handoff: otherRunHandoff };

    let accessorCalls = 0;
    const accessor = Object.defineProperty({ ...receipt() }, "organization_handoff", {
      enumerable: true,
      get: () => { accessorCalls += 1; return handoff; }
    });
    const cyclic = { ...receipt() } as Record<string, unknown>;
    cyclic.self = cyclic;
    const prototype = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(prototype, receipt());
    const oversized = { ...receipt(), fingerprint: "x".repeat(65_537) };
    const topLevelProxy = new Proxy(receipt(), {});

    for (const hostile of [forgedHandle, overlong, crossRun, accessor, cyclic, prototype, oversized, topLevelProxy]) {
      expect(() => upReceiptSchema.safeParse(hostile)).not.toThrow();
      expect(upReceiptSchema.safeParse(hostile).success).toBe(false);
    }
    expect(accessorCalls).toBe(0);
    expect(() => parseUpReceipt(crossRun)).toThrow(`invalid ${UP_RECEIPT_VERSION}`);
  });

  it("rejects nested mutations and hostile graphs without reflecting hostile material", () => {
    const hostileKey = "hostile_secret_key";
    const hostileValue = "opaque_secret_value";
    const cyclic = receipt();
    (cyclic.organization_handoff as typeof handoff & { loop?: unknown }).loop = cyclic;
    const accessor = Object.defineProperty(receipt(), "organization_handoff", {
      enumerable: true, get: () => handoff
    });
    const oversized = { ...receipt(), organization_handoff: Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`field_${index}`, "x"])
    ) };
    const proxy = new Proxy(receipt(), {});
    const mutations = [
      { ...receipt(), organization_handoff: { ...handoff, [hostileKey]: hostileValue } },
      { ...receipt(), organization_handoff: { ...handoff, version: "spawnfile.organization-handoff.v0" } },
      { ...receipt(), organization_handoff: { ...handoff, deployment_handle: `sf-oh1-${"0".repeat(64)}` } },
      { ...receipt(), organization_handoff: { ...handoff, binding_digest: "sha256:bad" } },
      { ...receipt(), organization_handoff: { ...handoff, network_attachment_handle: "opaque_bad" } },
      cyclic, accessor, oversized, proxy
    ];
    for (const value of mutations) {
      let message = "";
      try { parseUpReceipt(value); } catch (error) { message = String(error); }
      expect(message).toBe(`Error: invalid ${UP_RECEIPT_VERSION}`);
      expect(message).not.toContain(hostileKey);
      expect(message).not.toContain(hostileValue);
    }
  });
});
