import { describe, expect, it } from "vitest";

import {
  createCanonicalTargetWorldReadinessReceiptBytes,
  createTargetWorldReadinessReceipt,
  parseTargetWorldReadinessRequest,
  verifyTargetWorldReadinessReceipt
} from "./worldReadiness.js";

const d = (value: string): `sha256:${string}` =>
  `sha256:${value.repeat(64).slice(0, 64)}`;
const request = {
  descriptor_digest: d("a"),
  endpoint: { internal_port: 4_071, path: "/v1/world/readiness" },
  expected: {
    artifact_digest: d("b"),
    bundle_digest: d("c"),
    capability_manifest_digests: [d("d"), d("e")],
    document_version: "example.world-readiness.v1",
    mechanics_sha256: d("1"),
    normalized_checkpoint_sha256: d("2"),
    runtime_abi: "example.world-runtime.v1",
    world_instance_id: "run-ready-world"
  },
  run_id: "run-ready",
  selected_target: {
    fingerprint: `sha256:${"f".repeat(32)}`,
    handle: "opaque_1111111111111111"
  },
  version: "spawnfile.target-world-readiness.request.v1",
  world_service_handle: "opaque_2222222222222222"
} as const;
const document = {
  artifact_digest: d("b"),
  bundle_digest: d("c"),
  capability_manifest_digests: [d("d"), d("e")],
  clock: { next_tick: 0, state: "paused" },
  decisions: { count: 0, phase: "open" },
  mechanics_sha256: d("1"),
  normalized_checkpoint_sha256: d("2"),
  run_id: "run-ready",
  runtime_abi: "example.world-runtime.v1",
  status: "ready",
  version: "example.world-readiness.v1",
  world_instance_id: "run-ready-world"
} as const;

describe("target world-only readiness contract", () => {
  it("emits a versioned paused, pristine, world-only public receipt", () => {
    const parsed = parseTargetWorldReadinessRequest(request);
    const receipt = createTargetWorldReadinessReceipt({ document, request: parsed });
    expect(receipt.readiness.clock).toEqual({ next_tick: 0, state: "paused" });
    expect(receipt.readiness.decisions).toEqual({ count: 0, phase: "open" });
    expect(verifyTargetWorldReadinessReceipt({ receipt, request: parsed })).toEqual(receipt);
    expect(JSON.parse(createCanonicalTargetWorldReadinessReceiptBytes(receipt)))
      .toEqual(receipt);
    const publicBytes = JSON.stringify(receipt);
    expect(publicBytes).not.toContain("organization");
    expect(publicBytes).not.toContain("moltnet");
  });

  it("binds optional capability identities to exact manifest digests", () => {
    const capabilities = [{
      identity: "example.world-operation.v1",
      manifest_digest: d("d")
    }];
    const extendedRequest = {
      ...request,
      expected: { ...request.expected, capabilities }
    };
    const extendedDocument = { ...document, capabilities };
    const receipt = createTargetWorldReadinessReceipt({
      document: extendedDocument,
      request: extendedRequest
    });
    expect(receipt.readiness.capabilities).toEqual(capabilities);
    expect(() => createTargetWorldReadinessReceipt({
      document: {
        ...extendedDocument,
        capabilities: [{ ...capabilities[0], manifest_digest: d("9") }]
      },
      request: extendedRequest
    })).toThrow();
    expect(() => createTargetWorldReadinessReceipt({
      document: extendedDocument,
      request
    })).toThrow();
  });

  it("rejects org and transport surfaces plus non-pristine documents", () => {
    for (const invalid of [
      { ...request, organization_id: "org-private" },
      { ...request, moltnet_room: "room-private" },
      { ...request, team_id: "team-private" },
      { ...request, endpoint: { ...request.endpoint, path: "/mcp" } }
    ]) expect(() => parseTargetWorldReadinessRequest(invalid)).toThrow();
    for (const invalid of [
      { ...document, clock: { state: "running", next_tick: 1 } },
      { ...document, decisions: { phase: "open", count: 1 } },
      { ...document, capability_manifest_digests:
        [...document.capability_manifest_digests].reverse() }
    ]) expect(() => createTargetWorldReadinessReceipt({
      document: invalid,
      request
    })).toThrow();
  });

  it("rejects forged and stale readiness correlation", () => {
    const receipt = createTargetWorldReadinessReceipt({ document, request });
    for (const forged of [
      { ...receipt, request_digest: d("0") },
      { ...receipt, readiness_digest: d("0") },
      { ...receipt, readiness: { ...receipt.readiness, run_id: "run-stale" } }
    ]) expect(() => verifyTargetWorldReadinessReceipt({
      receipt: forged,
      request
    })).toThrow();
    expect(() => verifyTargetWorldReadinessReceipt({
      receipt,
      request: { ...request, run_id: "run-stale" }
    })).toThrow();
    for (const field of ["mechanics_sha256", "normalized_checkpoint_sha256"] as const) {
      expect(() => verifyTargetWorldReadinessReceipt({
        receipt,
        request: {
          ...request,
          expected: { ...request.expected, [field]: d("9") }
        }
      })).toThrow();
      expect(() => createTargetWorldReadinessReceipt({
        document: { ...document, [field]: d("9") },
        request
      })).toThrow();
    }
  });
});
