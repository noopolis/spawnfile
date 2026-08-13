import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseSelectedTargetReceipt } from "../target/contracts.js";
import {
  createSimfileRunOperatorReceipt,
  parseSimfileRunOperatorInput,
  resolveSimfileRunOperatorInput,
  verifySimfileRunOperatorReceipt
} from "./simfileRunOperatorInputs.js";

const targetSpecPath = path.resolve(import.meta.dirname, "../../specs/TARGETS.md");

describe("Simfile run operator target contract", () => {
  it("freezes the nonsecret selector, stdin config, named auth, roots, and receipt correlation", async () => {
    const spec = await readFile(targetSpecPath, "utf8");
    for (const required of [
      "spawnfile.simfile-run-operator-input.v1",
      "spawnfile.simfile-run-operator-receipt.v1",
      "target-config-producer gpu-4090",
      "only literal `--config -` is accepted",
      "named local profile `simfile-live`",
      "distinct `output/`, `evidence/`, `journal/`, and `cache/`",
      "spawnfile.moltnet-release-identity.v1",
      '"capabilities": ["pi-bridge"]'
    ]) {
      expect(spec, required).toContain(required);
    }
  });

  it("keeps private configuration and auth values out of the correlated receipt", async () => {
    const request = {
      auth_profile: "simfile-live",
      moltnet_release: {
        directory_transport: "operator-path",
        required_capability: "pi-bridge",
        stamp_version: "spawnfile.moltnet-release-stamp.v1"
      },
      run_id: "run-contract",
      run_root: "/operator/runs/run-contract",
      target_config_transport: "stdin",
      target_selector: "gpu-4090",
      version: "spawnfile.simfile-run-operator-input.v1"
    } as const;
    expect(() => parseSimfileRunOperatorInput({
      ...request,
      target_config: { bearer: "private-value" }
    })).toThrow();
    const resolution = resolveSimfileRunOperatorInput({
      request,
      moltnet_release: {
        architecture: "arm64",
        asset: "moltnet_linux_arm64.tar.gz",
        asset_sha256: `sha256:${"a".repeat(64)}`,
        capabilities: ["pi-bridge"],
        release_version: "v0.1.14",
        source_revision: "7baeb284ba0b1b5e454476141a557d68b5a4af0d",
        version: "spawnfile.moltnet-release-identity.v1"
      }
    });
    const selectedTarget = parseSelectedTargetReceipt({
      fingerprint: `sha256:${"b".repeat(32)}`,
      handle: "opaque_aaaaaaaaaaaaaaaa",
      version: "spawnfile.target-resource.selected-target.v1"
    });
    const receipt = createSimfileRunOperatorReceipt({ resolution, selected_target: selectedTarget });
    expect(verifySimfileRunOperatorReceipt({
      receipt,
      resolution,
      selected_target: selectedTarget
    })).toEqual(receipt);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(request.run_root);
    expect(serialized).not.toContain("target_config");
    expect(serialized).not.toContain("operator-path");
    expect(serialized).not.toContain("private-value");

    const spec = await readFile(targetSpecPath, "utf8");
    const normalized = spec.replaceAll(/\s+/gu, " ");
    expect(normalized).toContain(
      "Simfile may persist the secret-free receipt but must never persist or echo the producer's private configuration."
    );
    expect(spec).toContain("unpinned `latest` is forbidden");
  });
});
