import { describe, expect, it } from "vitest";

import {
  createSimfileRunOperatorReceipt,
  parseSimfileRunOperatorInput,
  parseSimfileRunOperatorReceipt,
  resolveSimfileRunOperatorInput,
  verifySimfileRunOperatorReceipt
} from "./simfileRunOperatorInputs.js";
import { parseSelectedTargetReceipt } from "../target/contracts.js";

const request = {
  version: "spawnfile.simfile-run-operator-input.v1",
  run_id: "run-example",
  target_selector: "gpu-4090",
  target_config_transport: "stdin",
  auth_profile: "simfile-live",
  run_root: "/operator/simfile/runs/run-example",
  moltnet_release: {
    directory_transport: "operator-path",
    required_capability: "pi-bridge",
    stamp_version: "spawnfile.moltnet-release-stamp.v1"
  }
} as const;
const moltnet = {
  version: "spawnfile.moltnet-release-identity.v1",
  release_version: "v0.1.14",
  source_revision: "7baeb284ba0b1b5e454476141a557d68b5a4af0d",
  architecture: "arm64",
  asset: "moltnet_linux_arm64.tar.gz",
  asset_sha256: `sha256:${"a".repeat(64)}`,
  capabilities: ["pi-bridge"]
} as const;
const selectedTarget = parseSelectedTargetReceipt({
  version: "spawnfile.target-resource.selected-target.v1",
  handle: "opaque_aaaaaaaaaaaaaaaa",
  fingerprint: `sha256:${"b".repeat(32)}`
});

describe("Simfile run operator input resolution", () => {
  it("resolves exact distinct roots and a verified Moltnet identity", () => {
    expect(parseSimfileRunOperatorInput(request)).toEqual(request);
    const resolution = resolveSimfileRunOperatorInput({
      request,
      moltnet_release: moltnet
    });
    expect(resolution).toMatchObject({
      version: "spawnfile.simfile-run-operator-resolution.v1",
      run_id: "run-example",
      target_selector: "gpu-4090",
      auth_profile: "simfile-live",
      roots: {
        output: "/operator/simfile/runs/run-example/output",
        evidence: "/operator/simfile/runs/run-example/evidence",
        journal: "/operator/simfile/runs/run-example/journal",
        cache: "/operator/simfile/runs/run-example/cache"
      },
      moltnet_release: moltnet
    });
    expect(new Set(Object.values(resolution.roots)).size).toBe(4);
  });

  it("rejects private config forms, root drift, latest, and mismatched assets", () => {
    for (const invalid of [
      { ...request, target_config_transport: "path" },
      { ...request, target_config: { token: "secret" } },
      { ...request, moltnet_release: {
        ...request.moltnet_release,
        trusted_authority: { release_version: "fixture" }
      } },
      { ...request, run_root: "relative/run-example" },
      { ...request, run_root: "/operator/simfile/runs/other-run" }
    ]) expect(() => parseSimfileRunOperatorInput(invalid)).toThrow();
    expect(() => resolveSimfileRunOperatorInput({
      request,
      moltnet_release: { ...moltnet, release_version: "latest" }
    })).toThrow();
    expect(() => resolveSimfileRunOperatorInput({
      request,
      moltnet_release: { ...moltnet, asset: "moltnet_linux_amd64.tar.gz" }
    })).toThrow();
  });
});

describe("Simfile run operator receipt", () => {
  it("emits and verifies one secret-free correlated receipt", () => {
    const resolution = resolveSimfileRunOperatorInput({ request, moltnet_release: moltnet });
    const receipt = createSimfileRunOperatorReceipt({ resolution, selected_target: selectedTarget });
    expect(parseSimfileRunOperatorReceipt(receipt)).toEqual(receipt);
    expect(verifySimfileRunOperatorReceipt({
      receipt,
      resolution,
      selected_target: selectedTarget
    })).toEqual(receipt);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(request.run_root);
    expect(serialized).not.toContain("target_config");
    expect(serialized).not.toContain("operator-path");
  });

  it("rejects forged, stale, and contradictory receipt correlation", () => {
    const resolution = resolveSimfileRunOperatorInput({ request, moltnet_release: moltnet });
    const receipt = createSimfileRunOperatorReceipt({ resolution, selected_target: selectedTarget });
    for (const forged of [
      { ...receipt, run_id: "run-other" },
      { ...receipt, roots_digest: `sha256:${"c".repeat(64)}` },
      { ...receipt, moltnet_release: { ...receipt.moltnet_release,
        asset_sha256: `sha256:${"d".repeat(64)}` } }
    ]) expect(() => verifySimfileRunOperatorReceipt({
      receipt: forged,
      resolution,
      selected_target: selectedTarget
    })).toThrow(/correlation/u);
  });
});
