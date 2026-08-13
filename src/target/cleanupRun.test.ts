import { describe, expect, it } from "vitest";

import {
  TARGET_RESOURCE_REQUEST_VERSION,
  parseOpaqueTargetHandle,
  parseRunId,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import { createCleanupRunOperations, type CleanupRunOperationsOptions, type CleanupRunPlan, type CleanupRunResource } from "./cleanupRun.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";

const handle = (value: string) => parseOpaqueTargetHandle(`opaque_${value.repeat(64).slice(0, 64)}`);
const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;
const selected = { fingerprint: `sha256:${"f".repeat(32)}`, handle: handle("t") };
const baseRequest = {
  cleanup_policy: "remove",
  descriptor_digest: digest("d"),
  evidence_volume_handle: handle("e"),
  expected_revision: 6,
  idempotency_key: "idem_cleanup000000001",
  operation: "cleanup_run",
  organization_attachment_handle: handle("a"),
  run_id: parseRunId("run-one"),
  secret_bindings_handle: handle("s"),
  selected_target: selected,
  version: TARGET_RESOURCE_REQUEST_VERSION,
  world_service_handle: handle("w")
} as const satisfies Extract<TargetResourceRequest, { operation: "cleanup_run" }>;
const claim = { operationHandle: handle("o"), requestDigest: digest("c") } satisfies TargetJournalClaim;
const resource = (name: string, value: ReturnType<typeof handle>): CleanupRunResource =>
  Object.freeze({ authority: Object.freeze({ name }), handle: value });
const fullPlan = (policy: "discard_evidence" | "remove" | "preserve_evidence" = "remove"): CleanupRunPlan => Object.freeze({
  attachment: resource("attachment", baseRequest.organization_attachment_handle),
  cleanupPolicy: policy,
  dataNetwork: resource("network", handle("n")),
  evidence: resource("evidence", baseRequest.evidence_volume_handle),
  exportState: "exported",
  secrets: resource("secrets", baseRequest.secret_bindings_handle),
  world: resource("world", baseRequest.world_service_handle)
});

const journal = () => {
  let completed: { receipt: TargetResourceReceipt; receiptBytes: string } | undefined;
  let pending = false;
  let completes = 0;
  const store: TargetJournalStore = {
    complete: async (_claim, raw) => {
      completes += 1;
      const receipt = raw as TargetResourceReceipt;
      completed = { receipt, receiptBytes: JSON.stringify(receipt) };
      pending = false;
      return completed;
    },
    read: async () => { throw new Error("cleanup orchestrator must not read the journal"); },
    reserve: async () => completed
      ? { kind: "replay", receipt: completed.receipt, receiptBytes: completed.receiptBytes }
      : pending ? { kind: "pending", claim } : (pending = true, { kind: "owner", claim }),
    resolveCompletedReceipt: async () => completed ?? null,
    withLifecycleLease: async (action) => action()
  };
  return { getCompletes: () => completes, store };
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
};
const fixture = (input: {
  readonly plan?: CleanupRunPlan;
  readonly prepare?: CleanupRunOperationsOptions["prepare"];
  readonly step?: (name: string) => Promise<void>;
} = {}) => {
  const trace: string[] = [];
  const state = journal();
  const run = async (name: string) => {
    trace.push(name);
    await input.step?.(name);
  };
  const operations = createCleanupRunOperations({
    journal: state.store,
    prepare: input.prepare ?? (async () => {
      trace.push("prepare");
      return input.plan ?? fullPlan();
    }),
    steps: {
      detachAttachment: async () => run("attachment"),
      preserveEvidence: async () => run("evidence:preserve"),
      removeDataNetwork: async () => run("network"),
      removeEvidence: async () => run("evidence:remove"),
      removeSecrets: async () => run("secrets"),
      removeWorld: async () => run("world")
    }
  });
  return { getCompletes: state.getCompletes, operations, trace };
};

describe("cleanup run orchestration", () => {
  it("prepares the whole plan before ordered removal and completes the sole claim", async () => {
    const value = fixture();
    const result = await value.operations.execute(baseRequest);
    expect(value.trace).toEqual(["prepare", "world", "attachment", "secrets", "evidence:remove", "network"]);
    expect(result.receipt).toMatchObject({ cleanup_state: "removed", operation: "cleanup_run", result_handle: null, resulting_revision: 7 });
    expect(value.getCompletes()).toBe(1);
  });

  it("preserves required evidence, skips absent optional resources, and removes the network last", async () => {
    const {
      organization_attachment_handle: _attachment,
      secret_bindings_handle: _secrets,
      world_service_handle: _world,
      ...preserveRequest
    } = baseRequest;
    const plan = Object.freeze({
      attachment: null,
      cleanupPolicy: "preserve_evidence" as const,
      dataNetwork: resource("network", handle("n")),
      evidence: resource("evidence", baseRequest.evidence_volume_handle),
      exportState: "incomplete" as const,
      secrets: null,
      world: null
    });
    const value = fixture({ plan });
    await expect(value.operations.execute({
      ...preserveRequest,
      cleanup_policy: "preserve_evidence"
    })).resolves.toMatchObject({ receipt: {
      cleanup_state: "preserved",
      export_state: "incomplete",
      result_handle: baseRequest.evidence_volume_handle
    } });
    expect(value.trace).toEqual(["prepare", "evidence:preserve", "network"]);
    await expect(value.operations.execute({
      ...baseRequest,
      cleanup_policy: "preserve_evidence",
      evidence_volume_handle: undefined
    })).rejects.toThrow("Target cleanup failed");
  });

  it("supports pre-network cleanup and projects its validated export state", async () => {
    const {
      evidence_volume_handle: _evidence,
      organization_attachment_handle: _attachment,
      world_service_handle: _world,
      ...preNetworkRequest
    } = baseRequest;
    const value = fixture({ plan: Object.freeze({
      attachment: null,
      cleanupPolicy: "remove" as const,
      dataNetwork: null,
      evidence: null,
      exportState: "not_requested" as const,
      secrets: resource("secrets", baseRequest.secret_bindings_handle),
      world: null
    }) });
    await expect(value.operations.execute(preNetworkRequest)).resolves.toMatchObject({ receipt: {
      cleanup_state: "removed",
      export_state: "not_requested",
      result_handle: null
    } });
    expect(value.trace).toEqual(["prepare", "secrets"]);
  });

  it("rejects impossible evidence and network relationships before the first mutation", async () => {
    const { evidence_volume_handle: _evidence, ...requestWithoutEvidence } = baseRequest;
    const value = fixture({ plan: Object.freeze({
      ...fullPlan(),
      evidence: null,
      exportState: "exported" as const
    }) });
    await expect(value.operations.execute(requestWithoutEvidence)).rejects.toThrow("Target cleanup failed");
    expect(value.trace).toEqual(["prepare"]);
    expect(value.getCompletes()).toBe(0);
    const missingNetwork = fixture({ plan: Object.freeze({
      ...fullPlan(),
      dataNetwork: null
    }) });
    await expect(missingNetwork.operations.execute(baseRequest)).rejects.toThrow("Target cleanup failed");
    expect(missingNetwork.trace).toEqual(["prepare"]);
    expect(missingNetwork.getCompletes()).toBe(0);
  });

  it("stops on the first failure, leaves the claim pending, and replays the exact idempotent plan on retry", async () => {
    let failSecrets = true;
    const value = fixture({ step: async (name) => {
      if (name === "secrets" && failSecrets) {
        failSecrets = false;
        throw new Error("crash");
      }
    } });
    await expect(value.operations.execute(baseRequest)).rejects.toThrow("Target cleanup failed");
    expect(value.trace).toEqual(["prepare", "world", "attachment", "secrets"]);
    expect(value.getCompletes()).toBe(0);
    await expect(value.operations.execute(baseRequest)).resolves.toMatchObject({ receipt: { cleanup_state: "removed" } });
    expect(value.trace).toEqual([
      "prepare", "world", "attachment", "secrets",
      "prepare", "world", "attachment", "secrets", "evidence:remove", "network"
    ]);
    expect(value.getCompletes()).toBe(1);
  });

  it("coalesces identical work, rejects changed requests, and replays completion without prepare or lowerers", async () => {
    const entered = deferred();
    const release = deferred();
    const value = fixture({ step: async (name) => {
      if (name === "world") {
        entered.resolve();
        await release.promise;
      }
    } });
    const first = value.operations.execute(baseRequest);
    await entered.promise;
    const identical = value.operations.execute(baseRequest);
    expect(identical).toBe(first);
    await expect(value.operations.execute({ ...baseRequest, cleanup_policy: "preserve_evidence" })).rejects.toThrow("Target cleanup failed");
    expect(value.trace).toEqual(["prepare", "world"]);
    release.resolve();
    await expect(Promise.all([first, identical])).resolves.toHaveLength(2);
    const terminalTrace = [...value.trace];
    await expect(value.operations.execute(baseRequest)).resolves.toMatchObject({ receipt: { cleanup_state: "removed" } });
    expect(value.trace).toEqual(terminalTrace);
    expect(value.getCompletes()).toBe(1);
  });
});
