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
  createDockerCleanupRunOperations,
  type DockerCleanupRunOptions
} from "./cleanupRunDocker.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { DockerSecretProviderError } from "./dockerSecretsProvider.js";
import {
  EVIDENCE_EXPORT_HELPER_CONTRACT,
  createEvidenceExportHandle,
  createEvidenceExportHelper,
  evidenceReceiptLabels,
  parseEvidenceVolumeAuthority
} from "./evidenceExportProvider.js";
import { type TargetJournalStore } from "./journal.js";
import { canonicalCleanupScenario, cleanupAuthorityStores, cleanupResourceExecutor } from "./cleanupRunDocker.test-helper.js";
const handle = (value: string) =>
  parseOpaqueTargetHandle(`opaque_${value.repeat(64).slice(0, 64)}`);
const digest = (value: string) =>
  `sha256:${(/^[a-f0-9]$/u.test(value) ? value : "a").repeat(64)}` as const;
const selected = { fingerprint: `sha256:${"f".repeat(32)}`, handle: handle("t") };
const runId = parseRunId("run-one");
const descriptor = digest("d");
const cleanupClaim = {
  operationHandle: handle("z"),
  requestDigest: digest("z")
};
type CleanupRequest = Extract<TargetResourceRequest, { operation: "cleanup_run" }>;
const baseRequest = (input: Partial<CleanupRequest> = {}): CleanupRequest => ({
  cleanup_policy: "remove",
  descriptor_digest: descriptor,
  expected_revision: 1,
  idempotency_key: "idem_cleanupdocker001",
  operation: "cleanup_run",
  run_id: runId,
  selected_target: selected,
  version: TARGET_RESOURCE_REQUEST_VERSION,
  ...input
});
const completed = (
  operation: TargetResourceRequest["operation"],
  resultHandle: ReturnType<typeof handle>,
  marker: string
) => {
  const operationHandle = handle(marker);
  const requestDigest = digest(marker);
  const receipt: TargetResourceReceipt = {
    cleanup_state: "not_requested",
    descriptor_digest: descriptor,
    export_state: "not_requested",
    labels: [],
    operation,
    operation_handle: operationHandle,
    receipt_digest: digest(marker === "a" ? "1" : marker),
    request_digest: requestDigest,
    result_handle: resultHandle,
    resulting_revision: 1,
    run_id: runId,
    selected_target: selected,
    version: TARGET_RESOURCE_RECEIPT_VERSION
  };
  return {
    entry: {
      operation,
      operation_handle: operationHandle,
      receipt_digest: receipt.receipt_digest,
      request_digest: requestDigest,
      state: "completed" as const
    },
    receipt
  };
};
const networkCompleted = () => {
  const seed = completed("create_data_network", handle("n"), "n");
  const spec = createDockerResourceSpec({
    kind: "data_network",
    operationHandle: seed.entry.operation_handle,
    requestDigest: seed.entry.request_digest,
    runId,
    selectedTargetHandle: selected.handle
  });
  return { ...seed, receipt: { ...seed.receipt, result_handle: spec.resultHandle }, spec };
};
const evidenceCompleted = () => {
  const seed = completed("create_evidence_volume", handle("e"), "e");
  const spec = createDockerResourceSpec({
    kind: "evidence_volume",
    operationHandle: seed.entry.operation_handle,
    requestDigest: seed.entry.request_digest,
    runId,
    selectedTargetHandle: selected.handle
  });
  return { ...seed, receipt: { ...seed.receipt, result_handle: spec.resultHandle }, spec };
};
const journal = (items: Array<ReturnType<typeof completed>>) => {
  const resolved = new Map(items.map((item) => [
    `${item.entry.operation_handle}\0${item.entry.request_digest}`,
    { receipt: item.receipt, receiptBytes: JSON.stringify(item.receipt) }
  ]));
  let reads = 0;
  let completes = 0;
  const store: TargetJournalStore = {
    withLifecycleLease: async (action) => action(),
    complete: async (_claim, raw) => {
      completes += 1;
      const receipt = raw as TargetResourceReceipt;
      return { receipt, receiptBytes: JSON.stringify(receipt) };
    },
    read: async () => {
      reads += 1;
      return {
        descriptor_digest: descriptor,
        entries: items.map(({ entry }) => entry),
        revision: items.length,
        run_id: runId,
        selected_target: selected,
        version: "spawnfile.target-resource.journal.v1"
      };
    },
    reserve: async () => ({ kind: "owner", claim: cleanupClaim }),
    resolveCompletedReceipt: async (claim) =>
      resolved.get(`${claim.operationHandle}\0${claim.requestDigest}`) ?? null
  };
  return { completes: () => completes, reads: () => reads, store };
};

const operations = (input: {
  readonly attachmentExecutor?: DockerCleanupRunOptions["attachmentExecutor"];
  readonly items: Array<ReturnType<typeof completed>>;
  readonly resourceSpecs: ReturnType<typeof createDockerResourceSpec>[];
  readonly secretExecutor?: DockerCleanupRunOptions["secretExecutor"];
  readonly storeValues?: Parameters<typeof cleanupAuthorityStores>[0];
  readonly worldExecutor?: DockerCleanupRunOptions["worldExecutor"];
}) => {
  const trackedJournal = journal(input.items);
  const resources = cleanupResourceExecutor(input.resourceSpecs);
  const { loads, ...authorityStores } = cleanupAuthorityStores(input.storeValues);
  let forbiddenCalls = 0;
  const forbidden = async () => {
    forbiddenCalls += 1;
    throw new Error("unexpected non-resource effect");
  };
  const adapter = createDockerCleanupRunOperations({
    attachmentExecutor: input.attachmentExecutor ?? forbidden,
    context: "production",
    journal: trackedJournal.store,
    resourceExecutor: resources.executor,
    secretExecutor: input.secretExecutor ?? forbidden,
    timeoutMs: 10_000,
    worldExecutor: input.worldExecutor ?? forbidden,
    ...authorityStores
  } as DockerCleanupRunOptions);
  return {
    adapter,
    forbiddenCalls: () => forbiddenCalls,
    journal: trackedJournal,
    loads,
    resources
  };
};

describe("private Docker cleanup adapter", () => {
  it("cleans an interrupted secret-only startup before any data network exists", async () => {
    const secret = completed("prepare_secret_bindings", handle("s"), "s");
    const calls: string[][] = [];
    const value = operations({
      items: [secret],
      resourceSpecs: [],
      secretExecutor: async (_file, args) => {
        calls.push([...args]);
        throw new DockerSecretProviderError("not_found");
      }
    });
    await expect(value.adapter.execute(baseRequest({
      expected_revision: 1,
      secret_bindings_handle: secret.receipt.result_handle!
    }))).resolves.toMatchObject({ receipt: {
      cleanup_state: "removed",
      export_state: "not_requested"
    } });
    expect(calls.map((args) => [args[2], args[3]])).toEqual([
      ["container", "inspect"],
      ["volume", "inspect"]
    ]);
    expect(value.resources.calls).toHaveLength(0);
    expect(value.forbiddenCalls()).toBe(0);
  });

  it("derives one network-only plan from one journal snapshot and delegates exact removal", async () => {
    const network = networkCompleted();
    const value = operations({ items: [network], resourceSpecs: [network.spec] });
    await expect(value.adapter.execute(baseRequest({ expected_revision: 1 })))
      .resolves.toMatchObject({ receipt: {
        cleanup_state: "removed",
        export_state: "not_requested"
      } });
    expect(value.journal.reads()).toBe(1);
    expect(value.journal.completes()).toBe(1);
    expect(value.resources.calls.map((call) => call[3])).toEqual([
      "inspect", "rm", "inspect"
    ]);
    expect(value.resources.calls.flat()).not.toEqual(expect.arrayContaining([
      "list", "ls", "filter", "prune", "--force"
    ]));
  });

  it("preserves exact unexported evidence as incomplete but refuses to remove it", async () => {
    const network = networkCompleted();
    const evidence = evidenceCompleted();
    const request = baseRequest({
      cleanup_policy: "preserve_evidence",
      evidence_volume_handle: evidence.spec.resultHandle,
      expected_revision: 2
    });
    const preserve = operations({
      items: [network, evidence],
      resourceSpecs: [network.spec, evidence.spec]
    });
    await expect(preserve.adapter.execute(request)).resolves.toMatchObject({
      receipt: { cleanup_state: "preserved", export_state: "incomplete" }
    });
    expect(preserve.resources.present.has(evidence.spec.name)).toBe(true);
    expect(preserve.resources.present.has(network.spec.name)).toBe(false);

    const remove = operations({
      items: [network, evidence],
      resourceSpecs: [network.spec, evidence.spec]
    });
    await expect(remove.adapter.execute({
      ...request,
      cleanup_policy: "remove",
      idempotency_key: "idem_cleanupdocker002"
    })).rejects.toThrow("Target cleanup failed");
    expect(remove.resources.calls).toHaveLength(0);
    expect(remove.forbiddenCalls()).toBe(0);

    const discard = operations({
      items: [network, evidence],
      resourceSpecs: [network.spec, evidence.spec]
    });
    await expect(discard.adapter.execute({
      ...request,
      cleanup_policy: "discard_evidence",
      idempotency_key: "idem_cleanupdocker003"
    })).resolves.toMatchObject({
      receipt: { cleanup_state: "removed", export_state: "incomplete" }
    });
    expect(discard.resources.present.has(evidence.spec.name)).toBe(false);
    expect(discard.resources.present.has(network.spec.name)).toBe(false);
    expect(discard.forbiddenCalls()).toBe(0);
  });

  it("fails preflight for omitted or duplicate cleanup-owned roles with zero effects", async () => {
    const network = networkCompleted();
    const evidence = evidenceCompleted();
    for (const items of [
      [network, evidence],
      [network, network]
    ]) {
      const value = operations({
        items,
        resourceSpecs: [network.spec, evidence.spec]
      });
      await expect(value.adapter.execute(baseRequest({
        expected_revision: items.length
      }))).rejects.toThrow("Target cleanup failed");
      expect(value.resources.calls).toHaveLength(0);
      expect(value.forbiddenCalls()).toBe(0);
    }
  });

  it("accepts exported evidence only through one matching admission and index", async () => {
    const network = networkCompleted();
    const evidence = evidenceCompleted();
    const exportedSeed = completed("export_evidence_volume", handle("x"), "x");
    const exportHandle = createEvidenceExportHandle({
      evidenceVolumeHandle: evidence.spec.resultHandle,
      operationHandle: exportedSeed.entry.operation_handle,
      requestDigest: exportedSeed.entry.request_digest
    });
    const authority = parseEvidenceVolumeAuthority({
      labels: evidence.spec.labels,
      name: evidence.spec.name,
      resultHandle: evidence.spec.resultHandle
    });
    const labels = evidenceReceiptLabels(authority);
    const exported = {
      ...exportedSeed,
      receipt: {
        ...exportedSeed.receipt,
        export_state: "exported" as const,
        labels,
        result_handle: exportHandle
      }
    };
    const admission = {
      descriptor_digest: descriptor,
      evidence_volume: authority,
      helper: createEvidenceExportHelper({
        artifactManifestDigest: digest("b"),
        imageDigest: digest("c"),
        imageReference: `registry.example/export@${digest("c")}`,
        resultHandle: handle("h")
      }),
      helper_contract: EVIDENCE_EXPORT_HELPER_CONTRACT,
      operation_handle: exported.entry.operation_handle,
      request_digest: exported.entry.request_digest,
      run_id: runId,
      selected_target: selected,
      version: "spawnfile.target-evidence-export.private.v1"
    };
    const value = operations({
      items: [network, evidence, exported],
      resourceSpecs: [network.spec, evidence.spec],
      storeValues: { admission, index: { index: {
        evidence_digest: digest("b"),
        export_handle: exportHandle,
        files: [{ bytes: 1, path: "actions/log.jsonl", sha256: digest("d") }],
        item_count: 1,
        labels,
        run_id: runId,
        source: { evidence_volume_handle: evidence.spec.resultHandle, state: "preserved" },
        state: "exported",
        version: "spawnfile.target-resource.export-index.v1"
      }, bytes: "{}" } }
    });
    await expect(value.adapter.execute(baseRequest({
      evidence_volume_handle: evidence.spec.resultHandle,
      expected_revision: 3
    }))).resolves.toMatchObject({ receipt: {
      cleanup_state: "removed",
      export_state: "exported"
    } });
    expect(value.resources.present.size).toBe(0);
  });

  it("accepts canonical agreeing bindings and rejects only canonical network disagreement", async () => {
    const network = networkCompleted();
    const worldSeed = completed("create_world_service", handle("w"), "w");
    const attachmentSeed = completed("attach_organization", handle("a"), "a");
    const secret = completed("prepare_secret_bindings", handle("s"), "s");
    const evidence = evidenceCompleted();
    const scenario = canonicalCleanupScenario({
      attachmentOperationHandle: attachmentSeed.entry.operation_handle,
      attachmentRequestDigest: attachmentSeed.entry.request_digest,
      descriptorDigest: descriptor,
      evidence: evidence.spec,
      evidenceOperationHandle: evidence.entry.operation_handle,
      evidenceRequestDigest: evidence.entry.request_digest,
      network: network.spec,
      networkOperationHandle: network.entry.operation_handle,
      networkRequestDigest: network.entry.request_digest,
      runId,
      secretHandle: secret.receipt.result_handle!,
      selected,
      worldOperationHandle: worldSeed.entry.operation_handle,
      worldRequestDigest: worldSeed.entry.request_digest
    });
    const world = {
      ...worldSeed,
      receipt: {
        ...worldSeed.receipt,
        result_handle: scenario.bindings.world.world_service_handle
      }
    };
    const attachment = {
      ...attachmentSeed,
      receipt: {
        ...attachmentSeed.receipt,
        result_handle: scenario.bindings.attachment.attachment_handle
      }
    };
    const common = {
      attachmentExecutor: scenario.attachmentExecutor,
      items: [network, evidence, secret, world, attachment],
      resourceSpecs: [network.spec, evidence.spec],
      secretExecutor: scenario.secretExecutor,
      storeValues: {
        attachment: scenario.bindings.attachment,
        world: scenario.bindings.world
      },
      worldExecutor: scenario.worldExecutor
    };
    const request = baseRequest({
      cleanup_policy: "preserve_evidence",
      evidence_volume_handle: evidence.spec.resultHandle,
      expected_revision: 5,
      organization_attachment_handle: attachment.receipt.result_handle!,
      secret_bindings_handle: secret.receipt.result_handle!,
      world_service_handle: world.receipt.result_handle!
    });
    const agreeing = operations(common);
    await expect(agreeing.adapter.execute(request)).resolves.toMatchObject({
      receipt: { cleanup_state: "preserved", export_state: "incomplete" }
    });
    expect(agreeing.forbiddenCalls()).toBe(0);
    expect(scenario.calls.world.length).toBeGreaterThan(0);
    expect(scenario.calls.attachment.length).toBeGreaterThan(0);
    expect(scenario.calls.secret.length).toBeGreaterThan(0);
    expect(agreeing.resources.calls.map((call) => [call[2], call[3]])).toEqual([
      ["volume", "inspect"],
      ["network", "inspect"],
      ["network", "rm"],
      ["network", "inspect"]
    ]);

    const delegated = Object.fromEntries(
      Object.entries(scenario.calls).map(([key, calls]) => [key, calls.length])
    );
    const rejected = operations({
      ...common,
      items: common.items.map((item) => item.entry.operation === "attach_organization"
        ? { ...item, receipt: {
          ...item.receipt,
          result_handle: scenario.drift.attachment.attachment_handle
        } }
        : item),
      storeValues: {
        attachment: scenario.drift.attachment,
        world: scenario.bindings.world
      }
    });
    await expect(rejected.adapter.execute({
      ...request,
      organization_attachment_handle: scenario.drift.attachment.attachment_handle
    })).rejects.toThrow("Target cleanup failed");
    expect(rejected.loads).toEqual({ attachment: 1, world: 1 });
    expect(rejected.resources.calls).toHaveLength(0);
    expect(rejected.forbiddenCalls()).toBe(0);
    expect(Object.fromEntries(
      Object.entries(scenario.calls).map(([key, calls]) => [key, calls.length])
    )).toEqual(delegated);
  });
});
