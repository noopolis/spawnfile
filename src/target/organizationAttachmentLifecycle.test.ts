import { describe, expect, it } from "vitest";

import {
  createOrganizationHandoff,
  parseCanonicalSha256Digest
} from "../deployment/organizationHandoffTypes.js";
import { parseOpaqueTargetHandle } from "./contracts.js";
import {
  createOrganizationAttachmentAuthorization,
  parseOrganizationAttachmentResolution
} from "./organizationAttachmentAuthority.js";
import {
  DockerOrganizationAttachmentProviderError,
  createDockerOrganizationAttachmentSpec,
  type DockerOrganizationAttachmentExecutor
} from "./organizationAttachmentProvider.js";
import {
  detachExactOrganizationAttachment
} from "./organizationAttachmentLifecycle.js";
import { createOrganizationAttachmentBinding } from "./organizationAttachmentStore.js";

const selected = {
  fingerprint: `sha256:${"1".repeat(32)}`,
  handle: parseOpaqueTargetHandle("opaque_0123456789abcdef")
};
const labels = {
  "com.spawnfile.compile_fingerprint": "sf1:compile",
  "com.spawnfile.deployment": "football",
  "com.spawnfile.project": "test-project",
  "com.spawnfile.run_id": "run-attachment",
  "com.spawnfile.unit": "football-container",
  "com.spawnfile.version": "0.1"
};

const fixtureBinding = () => {
  const authorization = createOrganizationAttachmentAuthorization({
    descriptorDigest: `sha256:${"d".repeat(64)}`,
    operationHandle: "opaque_1111111111111111",
    organizationHandoffHandle: "opaque_2222222222222222",
    requestDigest: `sha256:${"e".repeat(64)}`,
    runId: "run-attachment",
    selectedTarget: selected
  });
  const handoff = createOrganizationHandoff("run-attachment", {
    bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
    networkAttachmentHandle: parseOpaqueTargetHandle("opaque_abcdefghijklmnop"),
    selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"a".repeat(64)}`)
  });
  const resolution = parseOrganizationAttachmentResolution({
    authorization,
    descriptor_binding: {
      binding_digest: handoff.binding_digest,
      descriptor_digest: authorization.descriptor_digest
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
  const networkOperation = parseOpaqueTargetHandle("opaque_3333333333333333");
  const networkDigest = `sha256:${"3".repeat(64)}`;
  const spec = createDockerOrganizationAttachmentSpec({
    containerId: resolution.network_attachment.container_id,
    dataNetworkOperationHandle: networkOperation,
    dataNetworkRequestDigest: networkDigest,
    deploymentLabels: resolution.network_attachment.deployment_labels,
    operationHandle: resolution.authorization.operation_handle,
    organizationHandoffHandle: resolution.authorization.organization_handoff_handle,
    requestDigest: resolution.authorization.request_digest,
    runId: resolution.authorization.run_id,
    selectedTargetHandle: resolution.authorization.selected_target.handle
  });
  const binding = createOrganizationAttachmentBinding({
    dataNetworkOperationHandle: networkOperation,
    dataNetworkRequestDigest: networkDigest,
    networkId: "f".repeat(64),
    resolution,
    spec
  });
  return { binding, spec };
};

type Mode = "bad_ack" | "missing_after" | "success" | "throw_detached" | "throw_present";

const harness = (input: {
  attached?: boolean;
  containerPresent?: boolean;
  mode?: Mode;
}) => {
  const { binding, spec } = fixtureBinding();
  let attached = input.attached ?? true;
  let containerPresent = input.containerPresent ?? true;
  let networkPresent = true;
  let disconnects = 0;
  const calls: string[][] = [];
  const executions: Array<{ signal?: AbortSignal; timeout: number }> = [];
  const executor: DockerOrganizationAttachmentExecutor = async (_file, args, execution) => {
    calls.push(args);
    executions.push(execution);
    if (args[2] === "network" && args[3] === "inspect") {
      if (!networkPresent) throw new DockerOrganizationAttachmentProviderError("not_found");
      return {
        stderr: "",
        stdout: JSON.stringify([{
          Id: binding.data_network.id,
          Internal: true,
          Labels: spec.network.labels,
          Name: spec.network.name
        }])
      };
    }
    if (args[2] === "container" && args[3] === "inspect") {
      if (!containerPresent) throw new DockerOrganizationAttachmentProviderError("not_found");
      return {
        stderr: "",
        stdout: JSON.stringify([{ Attached: attached, Id: spec.containerId, Labels: labels }])
      };
    }
    if (args[2] === "network" && args[3] === "disconnect") {
      disconnects += 1;
      if (input.mode === "bad_ack") return { stderr: "", stdout: "unexpected\n" };
      if (input.mode === "throw_detached") {
        attached = false;
        throw new Error("connection dropped");
      }
      if (input.mode === "throw_present") throw new Error("connection dropped");
      attached = false;
      if (input.mode === "missing_after") networkPresent = false;
      return { stderr: "", stdout: "" };
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  return {
    binding,
    calls,
    disconnects: () => disconnects,
    executions,
    options: { context: "remote_host", executor, timeoutMs: 4_000 }
  };
};

describe("exact organization attachment lifecycle cleanup", () => {
  it("runtime-parses the complete immutable binding before provider calls", async () => {
    const run = harness({});
    await expect(detachExactOrganizationAttachment(
      { ...run.binding, injected: true }, run.options
    )).rejects.toThrow("Docker organization attachment failed");
    expect(run.calls).toEqual([]);
  });

  it("rejects hostile lifecycle options before provider calls", async () => {
    for (const invalid of [
      { context: "bad context" },
      { executor: null },
      { timeoutMs: 0 },
      { timeoutMs: 120_001 }
    ]) {
      const run = harness({});
      let providerCalls = 0;
      const executor = async () => {
        providerCalls += 1;
        return { stderr: "", stdout: "" };
      };
      await expect(detachExactOrganizationAttachment(
        run.binding, {
          context: "remote_host",
          executor,
          timeoutMs: 1,
          ...invalid
        } as never
      )).rejects.toThrow("Docker organization attachment failed");
      expect(providerCalls).toBe(0);
    }
  });

  it("proves the exact network before accepting an absent container", async () => {
    const run = harness({ containerPresent: false });
    await expect(detachExactOrganizationAttachment(run.binding, run.options))
      .resolves.toBeUndefined();
    expect(run.calls.map((args) => args.slice(2, 4))).toEqual([
      ["network", "inspect"],
      ["container", "inspect"]
    ]);
    expect(run.disconnects()).toBe(0);
  });

  it("disconnects exact IDs once and re-proves detached state and network", async () => {
    const run = harness({});
    await expect(detachExactOrganizationAttachment(run.binding, run.options))
      .resolves.toBeUndefined();
    expect(run.calls.map((args) => args.slice(2, 4))).toEqual([
      ["network", "inspect"],
      ["container", "inspect"],
      ["network", "disconnect"],
      ["container", "inspect"],
      ["network", "inspect"]
    ]);
    const mutation = run.calls[2]!;
    expect(mutation).toEqual([
      "--context", "remote_host", "network", "disconnect",
      run.binding.data_network.id,
      run.binding.resolution.network_attachment.container_id
    ]);
    expect(mutation).not.toContain("--force");
    expect(run.disconnects()).toBe(1);
  });

  it("forwards the exact signal and timeout to every provider call", async () => {
    const run = harness({});
    const controller = new AbortController();
    await detachExactOrganizationAttachment(run.binding, {
      ...run.options,
      signal: controller.signal,
      timeoutMs: 7_777
    });
    expect(run.executions).toHaveLength(5);
    for (const execution of run.executions) {
      expect(execution).toEqual({ signal: controller.signal, timeout: 7_777 });
    }
  });

  it("accepts an already-detached exact container without mutation", async () => {
    const run = harness({ attached: false });
    await expect(detachExactOrganizationAttachment(run.binding, run.options))
      .resolves.toBeUndefined();
    expect(run.disconnects()).toBe(0);
    expect(run.calls).toHaveLength(2);
  });

  it("reconciles an ambiguous mutation only when exact state is detached", async () => {
    const converged = harness({ mode: "throw_detached" });
    await expect(detachExactOrganizationAttachment(converged.binding, converged.options))
      .resolves.toBeUndefined();
    expect(converged.disconnects()).toBe(1);
    expect(converged.calls.at(-1)?.slice(2, 4)).toEqual(["network", "inspect"]);

    const present = harness({ mode: "throw_present" });
    await expect(detachExactOrganizationAttachment(present.binding, present.options))
      .rejects.toThrow("Docker organization attachment failed");
    expect(present.disconnects()).toBe(1);
    expect(present.calls).toHaveLength(4);
  });

  it("rejects non-canonical acknowledgement and missing final network", async () => {
    const badAck = harness({ mode: "bad_ack" });
    await expect(detachExactOrganizationAttachment(badAck.binding, badAck.options))
      .rejects.toThrow("Docker organization attachment failed");
    expect(badAck.calls).toHaveLength(3);
    expect(badAck.disconnects()).toBe(1);

    const missing = harness({ mode: "missing_after" });
    await expect(detachExactOrganizationAttachment(missing.binding, missing.options))
      .rejects.toThrow("Docker organization attachment failed");
    expect(missing.disconnects()).toBe(1);
  });
});
