import { chmod, mkdtemp, readdir, realpath, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
import { createDockerOrganizationAttachmentSpec } from "./organizationAttachmentProvider.js";
import {
  createOrganizationAttachmentBinding,
  createOrganizationAttachmentMutationAdmission,
  initializeOrganizationAttachmentAuthorityStore
} from "./organizationAttachmentStore.js";

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
const resolution = (containerId = "c".repeat(64)) => {
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
  return parseOrganizationAttachmentResolution({
    authorization,
    descriptor_binding: {
      binding_digest: handoff.binding_digest,
      descriptor_digest: authorization.descriptor_digest
    },
    handoff,
    network_attachment: {
      container_id: containerId,
      deployment_labels: labels,
      network_attachment_handle: handoff.network_attachment_handle
    },
    selected_target_binding: {
      receipt: { ...selected, version: "spawnfile.target-resource.selected-target.v1" },
      receipt_digest: handoff.selected_target_receipt_digest
    }
  });
};
const binding = (resolved = resolution()) => {
  const networkOperation = parseOpaqueTargetHandle("opaque_3333333333333333");
  const networkDigest = `sha256:${"3".repeat(64)}`;
  const spec = createDockerOrganizationAttachmentSpec({
    containerId: resolved.network_attachment.container_id,
    dataNetworkOperationHandle: networkOperation,
    dataNetworkRequestDigest: networkDigest,
    deploymentLabels: resolved.network_attachment.deployment_labels,
    operationHandle: resolved.authorization.operation_handle,
    organizationHandoffHandle: resolved.authorization.organization_handoff_handle,
    requestDigest: resolved.authorization.request_digest,
    runId: resolved.authorization.run_id,
    selectedTargetHandle: resolved.authorization.selected_target.handle
  });
  return createOrganizationAttachmentBinding({
    dataNetworkOperationHandle: networkOperation,
    dataNetworkRequestDigest: networkDigest,
    networkId: "f".repeat(64),
    resolution: resolved,
    spec
  });
};

describe("organization attachment authority store", () => {
  it("persists immutable 0600 resolution and attachment records under a 0700 root", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-attachment-")));
    const first = await initializeOrganizationAttachmentAuthorityStore(root);
    const second = await initializeOrganizationAttachmentAuthorityStore(root);
    const resolved = resolution(); const attached = binding(resolved);
    await Promise.all([first.bindResolution(resolved), second.bindResolution(resolved)]);
    await Promise.all([first.bindAttachment(attached), second.bindAttachment(attached)]);
    const admission = createOrganizationAttachmentMutationAdmission({
      binding: attached,
      operation: "attach_organization",
      operationHandle: resolved.authorization.operation_handle,
      requestDigest: resolved.authorization.request_digest
    });
    await expect(second.requireMutationAdmission(admission)).rejects.toThrow();
    await first.bindMutationAdmission(admission);
    await expect(second.requireMutationAdmission(admission)).resolves.toBeUndefined();
    await expect(second.requireMutationAdmission({
      ...admission,
      operation: "detach_organization"
    })).rejects.toThrow();
    expect(await second.loadAttachment(attached.attachment_handle)).toEqual(attached);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const files = await readdir(root);
    expect(files).toHaveLength(3);
    for (const file of files) expect((await stat(path.join(root, file))).mode & 0o777).toBe(0o600);
  });

  it("rejects cross-instance opaque-handoff remapping before a caller can use it", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-attachment-remap-")));
    const first = await initializeOrganizationAttachmentAuthorityStore(root);
    const second = await initializeOrganizationAttachmentAuthorityStore(root);
    await first.bindResolution(resolution());
    await expect(second.bindResolution(resolution("d".repeat(64))))
      .rejects.toThrow("Docker organization attachment failed");
    const original = binding();
    await first.bindAttachment(original);
    const changed = { ...original, data_network: { ...original.data_network, id: "e".repeat(64) } };
    await expect(second.bindAttachment(changed))
      .rejects.toThrow("Docker organization attachment failed");
    await expect(second.loadAttachment(original.attachment_handle)).resolves.toEqual(original);
  });

  it("fails closed on missing, permission-drifted, or symlinked authority", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-attachment-hostile-")));
    const root = path.join(parent, "store");
    const store = await initializeOrganizationAttachmentAuthorityStore(root);
    const attached = binding();
    await expect(store.loadAttachment(attached.attachment_handle)).rejects.toThrow();
    await store.bindResolution(attached.resolution);
    await store.bindAttachment(attached);
    const attachmentFile = (await readdir(root)).find((file) => file.endsWith(".attachment.json"))!;
    await chmod(path.join(root, attachmentFile), 0o644);
    await expect(store.loadAttachment(attached.attachment_handle)).rejects.toThrow();

    const real = path.join(parent, "real");
    const linked = path.join(parent, "linked");
    await initializeOrganizationAttachmentAuthorityStore(real);
    await symlink(real, linked);
    await expect(initializeOrganizationAttachmentAuthorityStore(linked)).rejects.toThrow();
  });
});
