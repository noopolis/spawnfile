import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createOrganizationHandoff, parseCanonicalSha256Digest } from "../deployment/organizationHandoffTypes.js";
import { createDockerOrganizationAttachmentOperations } from "./organizationAttachment.js";
import { parseOpaqueTargetHandle } from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { createTargetReceiptDigest } from "./handles.js";
import { initializeTargetJournal } from "./journal.js";
import { type OrganizationAttachmentAuthorization, type OrganizationAttachmentResolution } from "./organizationAttachmentAuthority.js";
import { initializeOrganizationAttachmentAuthorityStore } from "./organizationAttachmentStore.js";

const context = "gpu-4090";
const endpoint = "ssh://operator@gpu-4090";
const runId = "run-recovery";
const descriptor = `sha256:${"d".repeat(64)}`;
const containerId = "c".repeat(64);
const networkId = "a".repeat(64);
const labels = {
  "com.spawnfile.compile_fingerprint": "sf1:compile",
  "com.spawnfile.deployment": "football",
  "com.spawnfile.project": "test-project",
  "com.spawnfile.run_id": runId,
  "com.spawnfile.unit": "football-container",
  "com.spawnfile.version": "0.1"
};
const handoff = createOrganizationHandoff(runId, {
  bindingDigest: parseCanonicalSha256Digest(`sha256:${"b".repeat(64)}`),
  networkAttachmentHandle: parseOpaqueTargetHandle("opaque_abcdefghijklmnop"),
  selectedTargetReceiptDigest: parseCanonicalSha256Digest(`sha256:${"9".repeat(64)}`)
});

const setup = async () => {
  const selected = await selectTarget({
    context,
    execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) })
  });
  const journalRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-attach-recovery-journal-")));
  const authorityRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-attach-recovery-authority-")));
  const openJournal = () => initializeTargetJournal({
    context, descriptorDigest: descriptor, root: journalRoot, runId, selectedTarget: selected
  });
  const journal = await openJournal();
  const networkRequest = {
    descriptor_digest: descriptor,
    expected_revision: 0,
    idempotency_key: "idem_1111111111111111",
    operation: "create_data_network" as const,
    run_id: runId,
    selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
    version: "spawnfile.target-resource.request.v1" as const
  };
  const reserved = await journal.reserve(networkRequest);
  if (reserved.kind !== "owner") throw new Error("expected owner");
  const network = createDockerResourceSpec({
    kind: "data_network",
    operationHandle: reserved.claim.operationHandle,
    requestDigest: reserved.claim.requestDigest,
    runId,
    selectedTargetHandle: selected.handle
  });
  const receipt = {
    cleanup_state: "not_requested",
    descriptor_digest: descriptor,
    export_state: "not_requested",
    labels: Object.entries(network.labels).map(([key, value]) => ({ key, value })),
    operation: "create_data_network",
    operation_handle: reserved.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: reserved.claim.requestDigest,
    result_handle: network.resultHandle,
    resulting_revision: 1,
    run_id: runId,
    selected_target: networkRequest.selected_target,
    version: "spawnfile.target-resource.receipt.v1"
  };
  await journal.complete(reserved.claim, { ...receipt, receipt_digest: createTargetReceiptDigest(receipt) });
  const attach = {
    data_network_handle: network.resultHandle,
    descriptor_digest: descriptor,
    expected_revision: 1,
    idempotency_key: "idem_2222222222222222",
    operation: "attach_organization" as const,
    organization_handoff_handle: parseOpaqueTargetHandle("opaque_4444444444444444"),
    run_id: runId,
    selected_target: networkRequest.selected_target,
    version: "spawnfile.target-resource.request.v1" as const
  };
  const state = {
    attached: false,
    calls: [] as string[][],
    crashAfterMutation: false,
    failConnectBeforeMutation: false,
    pendingPostMutationCrash: false
  };
  const executor = vi.fn(async (_file: string, args: string[]) => {
    state.calls.push([...args]);
    if (args[0] === "context") return { stderr: "", stdout: JSON.stringify(endpoint) };
    if (args[2] === "network" && args[3] === "inspect") return {
      stderr: "", stdout: JSON.stringify([{ Id: networkId, Internal: true, Labels: network.labels, Name: network.name }])
    };
    if (args[2] === "container" && args[3] === "inspect") {
      if (state.pendingPostMutationCrash) {
        state.pendingPostMutationCrash = false;
        throw new Error("private crash detail");
      }
      return { stderr: "", stdout: JSON.stringify([{ Attached: state.attached, Id: containerId, Labels: labels }]) };
    }
    if (args[2] === "network" && args[3] === "connect") {
      if (state.failConnectBeforeMutation) throw new Error("private connect failure");
      state.attached = true;
      state.pendingPostMutationCrash = state.crashAfterMutation;
      return { stderr: "", stdout: "" };
    }
    if (args[2] === "network" && args[3] === "disconnect") {
      state.attached = false;
      state.pendingPostMutationCrash = state.crashAfterMutation;
      return { stderr: "", stdout: "" };
    }
    throw new Error("unexpected Docker command");
  });
  const resolve = (authorization: OrganizationAttachmentAuthorization, changed = false) => ({
    authorization,
    descriptor_binding: { binding_digest: handoff.binding_digest, descriptor_digest: authorization.descriptor_digest },
    handoff,
    network_attachment: {
      container_id: changed ? "e".repeat(64) : containerId,
      deployment_labels: labels,
      network_attachment_handle: handoff.network_attachment_handle
    },
    selected_target_binding: {
      receipt: { ...authorization.selected_target, version: "spawnfile.target-resource.selected-target.v1" },
      receipt_digest: handoff.selected_target_receipt_digest
    }
  } as OrganizationAttachmentResolution);
  const operations = async (changed = false) => createDockerOrganizationAttachmentOperations({
    authorityStore: await initializeOrganizationAttachmentAuthorityStore(authorityRoot),
    context,
    executor,
    journal: await openJournal(),
    resolver: { resolve: async ({ authorization }) => resolve(authorization, changed) }
  });
  return { attach, operations, state };
};

describe("organization attachment recovery", () => {
  it("does not launder a rejected fresh attach through an identical retry", async () => {
    const fixture = await setup();
    fixture.state.attached = true;
    await expect((await fixture.operations()).execute(fixture.attach)).rejects.toThrow(
      "Docker organization attachment failed"
    );
    await expect((await fixture.operations()).execute(fixture.attach)).rejects.toThrow(
      "Docker organization attachment failed"
    );
    fixture.state.attached = false;
    await expect((await fixture.operations()).execute(fixture.attach)).rejects.toThrow(
      "Docker organization attachment failed"
    );
    expect(fixture.state.calls.filter((args) => args[3] === "connect")).toHaveLength(0);
  });

  it("rejects a changed cross-process resolver mapping before retry Docker", async () => {
    const fixture = await setup();
    fixture.state.failConnectBeforeMutation = true;
    await expect((await fixture.operations()).execute(fixture.attach)).rejects.toThrow(
      "Docker organization attachment failed"
    );
    fixture.state.calls.length = 0;
    await expect((await fixture.operations(true)).execute(fixture.attach)).rejects.toThrow(
      "Docker organization attachment failed"
    );
    expect(fixture.state.calls).toEqual([]);

    fixture.state.failConnectBeforeMutation = false;
    const recovered = await (await fixture.operations()).execute(fixture.attach);
    expect(recovered.receipt.resulting_revision).toBe(2);
    expect(fixture.state.calls.filter((args) => args[3] === "connect")).toHaveLength(1);
  });

  it("adopts only the exact pending edge after connect succeeded before completion", async () => {
    const fixture = await setup();
    fixture.state.crashAfterMutation = true;
    await expect((await fixture.operations()).execute(fixture.attach)).rejects.toThrow();
    expect(fixture.state.attached).toBe(true);
    const connectCount = fixture.state.calls.filter((args) => args[3] === "connect").length;
    fixture.state.crashAfterMutation = false;
    const recovered = await (await fixture.operations()).execute(fixture.attach);
    expect(recovered.receipt.resulting_revision).toBe(2);
    expect(fixture.state.calls.filter((args) => args[3] === "connect")).toHaveLength(connectCount);
  });

  it("accepts an absent edge only for an exact pending detach recovery", async () => {
    const fixture = await setup();
    const attached = await (await fixture.operations()).execute(fixture.attach);
    const detach = {
      data_network_handle: fixture.attach.data_network_handle,
      descriptor_digest: descriptor,
      expected_revision: 2,
      idempotency_key: "idem_3333333333333333",
      operation: "detach_organization" as const,
      organization_attachment_handle: attached.receipt.result_handle!,
      run_id: runId,
      selected_target: fixture.attach.selected_target,
      version: "spawnfile.target-resource.request.v1" as const
    };
    fixture.state.crashAfterMutation = true;
    await expect((await fixture.operations()).execute(detach)).rejects.toThrow();
    expect(fixture.state.attached).toBe(false);
    const disconnects = fixture.state.calls.filter((args) => args[3] === "disconnect").length;
    fixture.state.crashAfterMutation = false;
    const recovered = await (await fixture.operations()).execute(detach);
    expect(recovered.receipt.resulting_revision).toBe(3);
    expect(fixture.state.calls.filter((args) => args[3] === "disconnect")).toHaveLength(disconnects);
  });

  it("does not launder a rejected fresh detach through an identical retry", async () => {
    const fixture = await setup();
    const attached = await (await fixture.operations()).execute(fixture.attach);
    const detach = {
      data_network_handle: fixture.attach.data_network_handle,
      descriptor_digest: descriptor,
      expected_revision: 2,
      idempotency_key: "idem_3333333333333333",
      operation: "detach_organization" as const,
      organization_attachment_handle: attached.receipt.result_handle!,
      run_id: runId,
      selected_target: fixture.attach.selected_target,
      version: "spawnfile.target-resource.request.v1" as const
    };
    fixture.state.attached = false;
    await expect((await fixture.operations()).execute(detach)).rejects.toThrow(
      "Docker organization attachment failed"
    );
    await expect((await fixture.operations()).execute(detach)).rejects.toThrow(
      "Docker organization attachment failed"
    );
    fixture.state.attached = true;
    await expect((await fixture.operations()).execute(detach)).rejects.toThrow(
      "Docker organization attachment failed"
    );
    expect(fixture.state.calls.filter((args) => args[3] === "disconnect")).toHaveLength(0);
  });
});
