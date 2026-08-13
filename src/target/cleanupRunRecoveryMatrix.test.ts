import { describe, expect, it } from "vitest";

import {
  TARGET_RESOURCE_RECEIPT_VERSION,
  TARGET_RESOURCE_REQUEST_VERSION,
  parseOpaqueTargetHandle,
  parseRunId,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import {
  createCleanupRunOperations,
  type CleanupRunPlan,
  type CleanupRunResource
} from "./cleanupRun.js";
import {
  createDockerCleanupRunOperations,
  type DockerCleanupRunOptions
} from "./cleanupRunDocker.js";
import {
  cleanupAuthorityStores,
  cleanupResourceExecutor
} from "./cleanupRunDocker.test-helper.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";

const handle = (value: string) =>
  parseOpaqueTargetHandle(`opaque_${value.repeat(64).slice(0, 64)}`);
const digest = (value: string) =>
  `sha256:${(/^[a-f0-9]$/u.test(value) ? value : "a").repeat(64)}` as const;
const selected = { fingerprint: `sha256:${"f".repeat(32)}`, handle: handle("t") };
const runId = parseRunId("run-recovery");
const descriptor = digest("d");
const claim = {
  operationHandle: handle("o"),
  requestDigest: digest("c")
} satisfies TargetJournalClaim;
const request = {
  cleanup_policy: "remove",
  descriptor_digest: descriptor,
  evidence_volume_handle: handle("e"),
  expected_revision: 5,
  idempotency_key: "idem_cleanuprecovery01",
  operation: "cleanup_run",
  organization_attachment_handle: handle("a"),
  run_id: runId,
  secret_bindings_handle: handle("s"),
  selected_target: selected,
  version: TARGET_RESOURCE_REQUEST_VERSION,
  world_service_handle: handle("w")
} as const satisfies Extract<TargetResourceRequest, { operation: "cleanup_run" }>;
const cleanupResource = (
  name: string,
  value: ReturnType<typeof handle>
): CleanupRunResource => Object.freeze({
  authority: Object.freeze({ name }),
  handle: value
});
const plan: CleanupRunPlan = Object.freeze({
  attachment: cleanupResource("attachment", request.organization_attachment_handle),
  cleanupPolicy: "remove",
  dataNetwork: cleanupResource("network", handle("n")),
  evidence: cleanupResource("evidence", request.evidence_volume_handle),
  exportState: "exported",
  secrets: cleanupResource("secrets", request.secret_bindings_handle),
  world: cleanupResource("world", request.world_service_handle)
});

const pendingJournal = () => {
  let completed: { receipt: TargetResourceReceipt; receiptBytes: string } | null = null;
  const store: TargetJournalStore = {
    withLifecycleLease: async (action) => action(),
    complete: async (_claim, raw) => {
      const receipt = raw as TargetResourceReceipt;
      completed = { receipt, receiptBytes: JSON.stringify(receipt) };
      return completed;
    },
    read: async () => { throw new Error("generic cleanup must not read"); },
    reserve: async () => completed
      ? { kind: "replay", ...completed }
      : { kind: "pending", claim },
    resolveCompletedReceipt: async () => completed
  };
  return store;
};

describe("cleanup crash recovery matrix", () => {
  it.each([
    ["world", 1],
    ["attachment", 2],
    ["evidence", 4],
    ["network", 5]
  ] as const)("retries exact idempotent cleanup after %s failure", async (failure, prefix) => {
    const trace: string[] = [];
    let crash = true;
    const step = async (name: string) => {
      trace.push(name);
      if (name === failure && crash) {
        crash = false;
        throw new Error("simulated crash");
      }
    };
    const operations = createCleanupRunOperations({
      journal: pendingJournal(),
      prepare: async () => plan,
      steps: {
        detachAttachment: async () => step("attachment"),
        preserveEvidence: async () => step("preserve"),
        removeDataNetwork: async () => step("network"),
        removeEvidence: async () => step("evidence"),
        removeSecrets: async () => step("secrets"),
        removeWorld: async () => step("world")
      }
    });
    await expect(operations.execute(request)).rejects.toThrow("Target cleanup failed");
    expect(trace).toHaveLength(prefix);
    await expect(operations.execute(request)).resolves.toMatchObject({
      receipt: { cleanup_state: "removed", export_state: "exported" }
    });
    expect(trace.slice(prefix)).toEqual([
      "world", "attachment", "secrets", "evidence", "network"
    ]);
  });

  it("rejects a completed receipt correlation drift before any cleanup effect", async () => {
    const operationHandle = handle("n");
    const requestDigest = digest("a");
    const network = createDockerResourceSpec({
      kind: "data_network",
      operationHandle,
      requestDigest,
      runId,
      selectedTargetHandle: selected.handle
    });
    const entry = {
      operation: "create_data_network" as const,
      operation_handle: operationHandle,
      receipt_digest: digest("b"),
      request_digest: requestDigest,
      state: "completed" as const
    };
    const receipt: TargetResourceReceipt = {
      cleanup_state: "not_requested",
      descriptor_digest: digest("e"),
      export_state: "not_requested",
      labels: [],
      operation: entry.operation,
      operation_handle: operationHandle,
      receipt_digest: entry.receipt_digest,
      request_digest: requestDigest,
      result_handle: network.resultHandle,
      resulting_revision: 1,
      run_id: runId,
      selected_target: selected,
      version: TARGET_RESOURCE_RECEIPT_VERSION
    };
    const journal: TargetJournalStore = {
      withLifecycleLease: async (action) => action(),
      complete: async () => { throw new Error("must not complete"); },
      read: async () => ({
        descriptor_digest: descriptor,
        entries: [entry],
        revision: 1,
        run_id: runId,
        selected_target: selected,
        version: "spawnfile.target-resource.journal.v1"
      }),
      reserve: async () => ({ kind: "owner", claim }),
      resolveCompletedReceipt: async () => ({
        receipt,
        receiptBytes: JSON.stringify(receipt)
      })
    };
    const resources = cleanupResourceExecutor([network]);
    const { loads: _loads, ...stores } = cleanupAuthorityStores();
    let forbidden = 0;
    const rejectEffect = async () => {
      forbidden += 1;
      throw new Error("effect");
    };
    const operations = createDockerCleanupRunOperations({
      attachmentExecutor: rejectEffect,
      context: "production",
      journal,
      resourceExecutor: resources.executor,
      secretExecutor: rejectEffect,
      timeoutMs: 10_000,
      worldExecutor: rejectEffect,
      ...stores
    } as DockerCleanupRunOptions);
    await expect(operations.execute({
      cleanup_policy: "remove",
      descriptor_digest: descriptor,
      expected_revision: 1,
      idempotency_key: "idem_cleanuprecovery02",
      operation: "cleanup_run",
      run_id: runId,
      selected_target: selected,
      version: TARGET_RESOURCE_REQUEST_VERSION
    })).rejects.toThrow("Target cleanup failed");
    expect(resources.calls).toHaveLength(0);
    expect(forbidden).toBe(0);
  });
});
