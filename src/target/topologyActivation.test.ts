import { describe, expect, it } from "vitest";

import {
  createCanonicalTargetTopologyActivationReceiptBytes,
  createCanonicalWorldServiceActivationBytes,
  createTargetTopologyActivationReceiptDigest,
  createWorldServiceActivationDigest,
  parseTargetTopologyActivationReceipt,
  parseWorldServiceActivation
} from "./topologyActivation.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const marker = {
  bundle_digest: digest("a"),
  run_id: "run-activation",
  state: "activated",
  topology_receipt_digest: digest("b"),
  topology_request_digest: digest("c"),
  version: "spawnfile.world-service-activation.v1"
} as const;

describe("target topology activation contracts", () => {
  it("emits exact canonical marker bytes and a self-verifying public receipt", () => {
    expect(createCanonicalWorldServiceActivationBytes(marker)).toBe(
      `${JSON.stringify(marker)}\n`
    );
    expect(createWorldServiceActivationDigest(marker)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const body = {
      activation_digest: createWorldServiceActivationDigest(marker),
      bundle_digest: marker.bundle_digest,
      receipt_digest: digest("0"),
      run_id: marker.run_id,
      state: marker.state,
      topology_receipt_digest: marker.topology_receipt_digest,
      topology_request_digest: marker.topology_request_digest,
      version: "spawnfile.target-topology-activation-receipt.v1" as const
    };
    const receipt = parseTargetTopologyActivationReceipt({
      ...body,
      receipt_digest: createTargetTopologyActivationReceiptDigest(body)
    });
    expect(receipt.receipt_digest).toBe(
      createTargetTopologyActivationReceiptDigest(receipt)
    );
    expect(createCanonicalTargetTopologyActivationReceiptBytes(receipt))
      .toBe(JSON.stringify(receipt));
  });

  it("rejects malformed, extra, and prototype-bearing activation packets", () => {
    for (const hostile of [
      { ...marker, state: "ready" },
      { ...marker, path: "/private" },
      { ...marker, topology_request_digest: "sha256:ABC" },
      Object.assign(Object.create({ inherited: true }), marker)
    ]) expect(() => parseWorldServiceActivation(hostile)).toThrow();
  });
});
