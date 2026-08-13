import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createOrganizationHandoff,
  parseCanonicalSha256Digest
} from "../deployment/organizationHandoffTypes.js";
import {
  createDockerOrganizationAttachmentOperations
} from "./organizationAttachment.js";
import { parseOpaqueTargetHandle, type TargetResourceReceipt } from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { createTargetReceiptDigest } from "./handles.js";
import { initializeTargetJournal } from "./journal.js";
import {
  type OrganizationAttachmentAuthorization,
  type OrganizationAttachmentResolution
} from "./organizationAttachmentAuthority.js";
import {
  initializeOrganizationAttachmentAuthorityStore
} from "./organizationAttachmentStore.js";

const runId = "run-attachment";
const descriptorDigest = `sha256:${"d".repeat(64)}`;
const context = "gpu-4090";
const endpoint = "ssh://operator@gpu-4090";
const containerId = "c".repeat(64);
const networkId = "a".repeat(64);
const handoffHandle = parseOpaqueTargetHandle("opaque_4444444444444444");
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

const selectedTarget = async () => selectTarget({
  context,
  execFile: async () => ({ stderr: "", stdout: JSON.stringify(endpoint) })
});

const seedJournal = async () => {
  const selected = await selectedTarget();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-attachment-journal-")));
  const journal = await initializeTargetJournal({
    context,
    descriptorDigest,
    root,
    runId,
    selectedTarget: selected
  });
  const request = {
    descriptor_digest: descriptorDigest,
    expected_revision: 0,
    idempotency_key: "idem_1111111111111111",
    operation: "create_data_network" as const,
    run_id: runId,
    selected_target: { fingerprint: selected.fingerprint, handle: selected.handle },
    version: "spawnfile.target-resource.request.v1" as const
  };
  const reservation = await journal.reserve(request);
  if (reservation.kind !== "owner") throw new Error("expected owner");
  const spec = createDockerResourceSpec({
    kind: "data_network",
    operationHandle: reservation.claim.operationHandle,
    requestDigest: reservation.claim.requestDigest,
    runId,
    selectedTargetHandle: selected.handle
  });
  const raw = {
    cleanup_state: "not_requested",
    descriptor_digest: descriptorDigest,
    export_state: "not_requested",
    labels: Object.entries(spec.labels).map(([key, value]) => ({ key, value })),
    operation: "create_data_network",
    operation_handle: reservation.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: reservation.claim.requestDigest,
    result_handle: spec.resultHandle,
    resulting_revision: 1,
    run_id: runId,
    selected_target: request.selected_target,
    version: "spawnfile.target-resource.receipt.v1"
  };
  await journal.complete(reservation.claim, {
    ...raw,
    receipt_digest: createTargetReceiptDigest(raw)
  });
  return { journal, network: spec, selected };
};

const resolutionFor = (
  authorization: OrganizationAttachmentAuthorization,
  mutate?: (resolution: OrganizationAttachmentResolution) => unknown
): unknown => {
  const resolution = {
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
      receipt: {
        ...authorization.selected_target,
        version: "spawnfile.target-resource.selected-target.v1" as const
      },
      receipt_digest: handoff.selected_target_receipt_digest
    }
  } as OrganizationAttachmentResolution;
  return mutate ? mutate(resolution) : resolution;
};

const setup = async (options: {
  readonly attached?: boolean;
  readonly containerLabels?: typeof labels;
  readonly mutateNetwork?: (projection: Record<string, unknown>) => Record<string, unknown>;
  readonly mutateResolution?: (resolution: OrganizationAttachmentResolution) => unknown;
} = {}) => {
  const seeded = await seedJournal();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-attachment-authority-")));
  const authorityStore = await initializeOrganizationAttachmentAuthorityStore(root);
  const calls: string[][] = [];
  let attached = options.attached ?? false;
  let resolverDisabled = false;
  const resolver = {
    resolve: vi.fn(async ({ authorization }: { authorization: OrganizationAttachmentAuthorization }) => {
      if (resolverDisabled) throw new Error("resolver must not run");
      return resolutionFor(authorization, options.mutateResolution);
    })
  };
  const executor = vi.fn(async (_file: string, args: string[]) => {
    calls.push([...args]);
    if (args[0] === "context") return { stderr: "", stdout: JSON.stringify(endpoint) };
    if (args[2] === "network" && args[3] === "inspect") {
      const base = { Id: networkId, Internal: true, Labels: seeded.network.labels, Name: seeded.network.name };
      return { stderr: "", stdout: JSON.stringify([options.mutateNetwork?.(base) ?? base]) };
    }
    if (args[2] === "container" && args[3] === "inspect") {
      return { stderr: "", stdout: JSON.stringify([{
        Attached: attached,
        Id: containerId,
        Labels: options.containerLabels ?? labels
      }]) };
    }
    if (args[2] === "network" && args[3] === "connect"
      && args[4] === networkId && args[5] === containerId) {
      attached = true; return { stderr: "", stdout: "" };
    }
    if (args[2] === "network" && args[3] === "disconnect"
      && args[4] === networkId && args[5] === containerId) {
      attached = false; return { stderr: "", stdout: "" };
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  });
  const operations = createDockerOrganizationAttachmentOperations({
    authorityStore,
    context,
    executor,
    journal: seeded.journal,
    resolver
  });
  const attach = {
    data_network_handle: seeded.network.resultHandle,
    descriptor_digest: descriptorDigest,
    expected_revision: 1,
    idempotency_key: "idem_2222222222222222",
    operation: "attach_organization" as const,
    organization_handoff_handle: handoffHandle,
    run_id: runId,
    selected_target: { fingerprint: seeded.selected.fingerprint, handle: seeded.selected.handle },
    version: "spawnfile.target-resource.request.v1" as const
  };
  return {
    attach,
    calls,
    disableResolver: () => { resolverDisabled = true; },
    executor,
    journal: seeded.journal,
    operations,
    resolver
  };
};

describe("organization attachment operations", () => {
  it("attaches and detaches only the exact ID-bound edge with byte-exact replay", async () => {
    const fixture = await setup();
    const attached = await fixture.operations.execute(fixture.attach);
    expect(attached.receipt.operation).toBe("attach_organization");
    expect(attached.receipt.result_handle).toMatch(/^opaque_[a-f0-9]{64}$/u);
    expect(attached.receipt.resulting_revision).toBe(2);
    const callsAfterAttach = fixture.calls.length;
    const replay = await fixture.operations.execute(fixture.attach);
    expect(replay.receiptBytes).toBe(attached.receiptBytes);
    expect(fixture.calls).toHaveLength(callsAfterAttach);
    expect(fixture.resolver.resolve).toHaveBeenCalledTimes(1);

    fixture.disableResolver();
    const detach = {
      data_network_handle: fixture.attach.data_network_handle,
      descriptor_digest: descriptorDigest,
      expected_revision: 2,
      idempotency_key: "idem_3333333333333333",
      operation: "detach_organization" as const,
      organization_attachment_handle: attached.receipt.result_handle!,
      run_id: runId,
      selected_target: fixture.attach.selected_target,
      version: "spawnfile.target-resource.request.v1" as const
    };
    const detached = await fixture.operations.execute(detach);
    expect(detached.receipt.result_handle).toBeNull();
    expect(detached.receipt.resulting_revision).toBe(3);
    expect(fixture.resolver.resolve).toHaveBeenCalledTimes(1);
    const mutations = fixture.calls.filter((args) => args[2] === "network"
      && (args[3] === "connect" || args[3] === "disconnect"));
    expect(mutations).toEqual([
      ["--context", context, "network", "connect", networkId, containerId],
      ["--context", context, "network", "disconnect", networkId, containerId]
    ]);
    expect(fixture.calls.flat()).not.toContain("list");
    expect(fixture.calls.flat()).not.toContain("ls");
    expect(fixture.calls.flat()).not.toContain("ps");
    const publicBytes = `${attached.receiptBytes}${detached.receiptBytes}`;
    for (const privateValue of [containerId, networkId, fixture.calls[2]?.at(-1) ?? "", endpoint]) {
      expect(publicBytes).not.toContain(privateValue);
    }
  });

  it("rejects resolver authority drift before the first Docker call", async () => {
    const fixture = await setup({
      mutateResolution: (resolution) => ({
        ...resolution,
        selected_target_binding: {
          ...resolution.selected_target_binding,
          receipt_digest: `sha256:${"0".repeat(64)}`
        }
      })
    });
    await expect(fixture.operations.execute(fixture.attach))
      .rejects.toThrow("Docker organization attachment failed");
    expect(fixture.calls).toEqual([]);
  });

  it("fails closed on network, container-label, and fresh-edge drift without mutation", async () => {
    const fixtures = [
      await setup({ mutateNetwork: (value) => ({ ...value, Internal: false }) }),
      await setup({ containerLabels: { ...labels, "com.spawnfile.unit": "other-unit" } }),
      await setup({ attached: true })
    ];
    for (const fixture of fixtures) {
      await expect(fixture.operations.execute(fixture.attach))
        .rejects.toThrow("Docker organization attachment failed");
      expect(fixture.calls.some((args) => args[3] === "connect")).toBe(false);
    }
  });

  it("joins concurrent identical calls and rejects a changed live request", async () => {
    const fixture = await setup();
    const first = fixture.operations.execute(fixture.attach);
    const second = fixture.operations.execute(fixture.attach);
    const changed = fixture.operations.execute({
      ...fixture.attach,
      descriptor_digest: `sha256:${"0".repeat(64)}`
    });
    await expect(changed).rejects.toThrow("Docker organization attachment failed");
    const [left, right] = await Promise.all([first, second]);
    expect(left.receiptBytes).toBe(right.receiptBytes);
    expect(fixture.resolver.resolve).toHaveBeenCalledTimes(1);
    expect(fixture.calls.filter((args) => args[3] === "connect")).toHaveLength(1);
  });
});
