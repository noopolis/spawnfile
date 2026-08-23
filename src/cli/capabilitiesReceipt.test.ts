import { describe, expect, it } from "vitest";

import {
  CAPABILITIES_RECEIPT_VERSION,
  createCapabilitiesReceipt,
  createCapabilitiesReceiptBytes,
} from "./capabilitiesReceipt.js";

describe("capabilities receipt", () => {
  it("reports generic public contracts with their exact versions", () => {
    const receipt = createCapabilitiesReceipt("0.1.17");
    expect(receipt.version).toBe(CAPABILITIES_RECEIPT_VERSION);
    expect(receipt.implementation).toEqual({ cli: "spawnfile", package: "spawnfile", version: "0.1.17" });
    expect(receipt.capabilities.optional_model_auth.required).toBe(false);
    expect(receipt.capabilities.evidence_export_helper).toEqual({
      identity: "docker-image-config-digest",
      local_context_only: true,
      prepare_command: ["helper", "prepare-evidence-export", "--context", "<name>", "--json"],
      receipt_version: "spawnfile.target-evidence-export-helper.prepared.v1",
      resolver_option: "--prepare-evidence-helper",
      provisioning: "spawnfile-owned-target-local",
    });
    expect(receipt.capabilities.composed_lifecycle).toMatchObject({
      command_set_version: "spawnfile.composed-lifecycle-contract-set.v1",
      complete: true,
    });
    const commands = receipt.capabilities.composed_lifecycle.commands;
    const find = (argv: readonly string[]) => commands.find((command) =>
      JSON.stringify(command.argv) === JSON.stringify(argv));
    expect(commands).toHaveLength(43);
    for (const command of commands) {
      expect(command).toEqual(expect.objectContaining({ argv: expect.any(Array), stdout: expect.any(String) }));
      expect(command.invocation_versions).toEqual(expect.any(Array));
      expect(command.pending_versions).toEqual(expect.any(Array));
      expect(command.receipt_versions).toEqual(expect.any(Array));
      expect(command.request_versions).toEqual(expect.any(Array));
      expect(command.stdin_versions).toEqual(expect.any(Array));
    }
    expect(find(["target", "--config", "-", "activate_topology", "<request-file>"]))
      .toMatchObject({
        request_versions: ["spawnfile.target-topology-attestation.request.v1"],
        receipt_versions: ["spawnfile.target-topology-activation-receipt.v1"],
        stdin_versions: ["spawnfile.target-default-config.v1"],
      });
    expect(find(["target", "--config", "-", "lookup_operation", "<request-file>"]))
      .toMatchObject({
        pending_versions: ["spawnfile.target-resource.operation-lookup.v1"],
        receipt_versions: ["spawnfile.target-resource.operation-lookup.v1"],
        stdin_versions: ["spawnfile.target-lookup-config.v1"],
      });
    expect(find(["auth", "provision", "<request-file>"])).toMatchObject({
      receipt_versions: ["spawnfile.auth.credential-provisioning.receipt.v1"],
      request_versions: [
        "spawnfile.auth.credential-provisioning.request.v1",
        "spawnfile.auth.resolved-world-grants.v1",
      ],
    });
    expect(find(["auth", "target-secret", "revoke-grant", "<request-file>"]))
      .toMatchObject({ request_versions: ["spawnfile.auth.target-secret.source-request.v1"] });
    expect(find(["target", "--config", "-", "export_evidence_volume", "<request-file>"]))
      .toMatchObject({
        receipt_versions: [
          "spawnfile.target-resource.receipt.v1",
          "spawnfile.target-resource.export-index.v1",
        ],
      });
    expect(find(["lifecycle", "plan", "--request", "<file|->"])).toMatchObject({
      request_versions: ["spawnfile.lifecycle-plan-request.v1"],
      receipt_versions: ["spawnfile.lifecycle-invocation.v1"],
    });
    expect(find([
      "up", "<project>", "--detach", "--deployment", "<name>", "--json",
      "--lifecycle-invocation", "<id>", "--organization-handoff-run-id", "<run-id>",
      "--descriptor-digest", "<digest>", "--selected-target-receipt", "<file>",
      "--selected-target-receipt-digest", "<digest>", "--network-attachment-handle", "<handle>",
      "--world-bindings", "<file>",
    ])).toMatchObject({
      invocation_versions: ["spawnfile.lifecycle-invocation.v1"],
      pending_versions: ["spawnfile.lifecycle-lookup.v1"],
      receipt_versions: ["spawnfile.up-receipt.v1"],
    });
    expect(receipt.capabilities.composed_lifecycle.commands).not.toContainEqual(
      expect.objectContaining({ argv: ["up", "--image", "--json"] })
    );
    expect(receipt.capabilities.terminal_public_artifact.not_present_version)
      .toBe("spawnfile.target-public-artifact-snapshot.not-present.v1");
    expect(receipt.capabilities.target_config_resolver.target_config_digest_version)
      .toBe("spawnfile.target-config-digest.v1");
    expect(JSON.parse(createCapabilitiesReceiptBytes(receipt))).toEqual(receipt);
    expect(Object.isFrozen(receipt.capabilities.target_config_resolver)).toBe(true);
  });

  it("rejects a non-package version", () => {
    expect(() => createCapabilitiesReceipt("development")).toThrow("Invalid Spawnfile package version");
  });
});
