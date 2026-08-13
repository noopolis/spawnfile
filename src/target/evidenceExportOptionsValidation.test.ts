import { describe, expect, it } from "vitest";

import { TARGET_RESOURCE_REQUEST_VERSION } from "./contracts.js";
import {
  createEvidenceExportOperations,
  type EvidenceExportOperationsOptions,
} from "./evidenceExport.js";
import { EVIDENCE_EXPORT_HELPER_CONTRACT } from "./evidenceExportProvider.js";

const digest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
const target = {
  fingerprint: `sha256:${"b".repeat(32)}`,
  handle: `opaque_${"c".repeat(16)}`,
} as const;
const operationHandle = `opaque_${"d".repeat(16)}`;
const requestDigest = `sha256:${"e".repeat(64)}`;
const resultHandle = `opaque_${"f".repeat(16)}`;

const authorityStore = {
  bindAdmission: async () => undefined,
  bindDestination: async () => undefined,
  bindIndex: async () => "{}",
  claimExport: async () => null,
  clearStaleExportClaim: async () => false,
  loadAdmission: async () => { throw new Error("unused"); },
  loadIndex: async () => null,
  releaseExport: async () => undefined,
  requireDestination: async () => undefined,
};
const artifactIdentityStore = {
  bind: async () => { throw new Error("unused"); },
  bindOperation: async () => { throw new Error("unused"); },
  resolveOperation: async () => null,
};
const journal = {
  complete: async () => { throw new Error("unused"); },
  read: async () => { throw new Error("unused"); },
  reserve: async () => { throw new Error("unused"); },
  resolveCompletedReceipt: async () => null,
  withLifecycleLease: async <Result>(action: () => Promise<Result>) => action(),
};
const executor = async () => ({ stderr: "", stdout: "" });
const exportExecutor = async () => ({ bytes: new Uint8Array() });
const base = (): EvidenceExportOperationsOptions => ({
  artifactIdentityStore,
  authorityStore,
  context: "test_context",
  executor,
  exportExecutor,
  helperArtifactBundle: {
    operation_handle: operationHandle,
    request_digest: requestDigest,
    result_handle: resultHandle,
  },
  helperArtifactContract: EVIDENCE_EXPORT_HELPER_CONTRACT,
  helperArtifactManifestDigest: digest,
  journal,
});
const mutate = (
  change: (value: Record<string, unknown>) => void,
): EvidenceExportOperationsOptions => {
  const value = { ...base() } as unknown as Record<string, unknown>;
  change(value);
  return value as unknown as EvidenceExportOperationsOptions;
};
const helperMutation = (
  change: (value: Record<string, unknown>) => void,
): EvidenceExportOperationsOptions => mutate((options) => {
  const helper = { ...(options.helperArtifactBundle as Record<string, unknown>) };
  change(helper);
  options.helperArtifactBundle = helper;
});

const exportRequest = {
  descriptor_digest: digest,
  evidence_volume_handle: `opaque_${"1".repeat(16)}`,
  expected_revision: 0,
  idempotency_key: `idem_${"2".repeat(16)}`,
  operation: "export_evidence_volume",
  run_id: "run-one",
  selected_target: target,
  version: TARGET_RESOURCE_REQUEST_VERSION,
} as const;
const recoverRequest = {
  descriptor_digest: digest,
  expected_revision: 0,
  idempotency_key: `idem_${"3".repeat(16)}`,
  operation: "recover_operation",
  operation_handle: operationHandle,
  run_id: "run-one",
  selected_target: target,
  version: TARGET_RESOURCE_REQUEST_VERSION,
} as const;

describe("evidence export option and scalar validation", () => {
  it("accepts exact wiring and both timeout boundaries", () => {
    expect(createEvidenceExportOperations(base())).toBeDefined();
    expect(createEvidenceExportOperations({ ...base(), timeoutMs: 1 })).toBeDefined();
    expect(createEvidenceExportOperations({ ...base(), timeoutMs: 120_000 })).toBeDefined();
  });

  it("rejects malformed top-level authority wiring", () => {
    const cases = [
      mutate((value) => { value.context = 7; }),
      mutate((value) => { value.context = "UPPER"; }),
      mutate((value) => { value.executor = null; }),
      mutate((value) => { value.exportExecutor = null; }),
      mutate((value) => { value.authorityStore = null; }),
      mutate((value) => { value.artifactIdentityStore = null; }),
      mutate((value) => { value.journal = null; }),
      mutate((value) => { value.timeoutMs = "10"; }),
      mutate((value) => { value.timeoutMs = 0; }),
      mutate((value) => { value.timeoutMs = 120_001; }),
      mutate((value) => { value.timeoutMs = 1.5; }),
    ];
    for (const options of cases) {
      expect(() => createEvidenceExportOperations(options)).toThrow("Evidence-volume export failed");
    }
  });

  it("requires every private authority method", () => {
    for (const name of [
      "bindAdmission", "bindDestination", "requireDestination", "claimExport",
      "releaseExport", "loadAdmission", "loadIndex", "clearStaleExportClaim",
    ]) {
      const options = mutate((value) => {
        value.authorityStore = { ...authorityStore, [name]: undefined };
      });
      expect(() => createEvidenceExportOperations(options)).toThrow("Evidence-volume export failed");
    }
    for (const [owner, value] of [
      ["artifactIdentityStore", { ...artifactIdentityStore, resolveOperation: undefined }],
      ["journal", { ...journal, resolveCompletedReceipt: undefined }],
    ] as const) {
      const options = mutate((raw) => { raw[owner] = value; });
      expect(() => createEvidenceExportOperations(options)).toThrow("Evidence-volume export failed");
    }
  });

  it("rejects malformed helper bundle provenance", () => {
    const cases = [
      mutate((value) => { value.helperArtifactBundle = null; }),
      mutate((value) => { value.helperArtifactBundle = []; }),
      helperMutation((value) => { value.extra = true; }),
      helperMutation((value) => { value.operation_handle = "container-id"; }),
      helperMutation((value) => { value.request_digest = 7; }),
      helperMutation((value) => { value.request_digest = "bad"; }),
      helperMutation((value) => { value.result_handle = "container-id"; }),
      mutate((value) => { value.helperArtifactManifestDigest = 7; }),
      mutate((value) => { value.helperArtifactManifestDigest = "bad"; }),
      mutate((value) => { value.helperArtifactContract = "wrong"; }),
    ];
    for (const options of cases) {
      expect(() => createEvidenceExportOperations(options)).toThrow("Evidence-volume export failed");
    }
  });

  it("rejects wrong operation kinds and every unsafe destination scalar", async () => {
    const operations = createEvidenceExportOperations(base());
    await expect(operations.execute(null, "/tmp/match.tar")).rejects.toThrow("Evidence-volume export failed");
    await expect(operations.execute(recoverRequest, "/tmp/match.tar")).rejects.toThrow("Evidence-volume export failed");
    await expect(operations.recover(null, "/tmp/match.tar")).rejects.toThrow("Evidence-volume export failed");
    await expect(operations.recover(exportRequest, "/tmp/match.tar")).rejects.toThrow("Evidence-volume export failed");
    for (const destination of [
      null,
      "",
      "x",
      `/${"x".repeat(4_096)}.tar`,
      "relative.tar",
      "/tmp/../match.tar",
      "/tmp/.tar",
      "/tmp/unsafe?.tar",
      `/tmp/\ud800.tar`,
    ]) {
      await expect(operations.execute(exportRequest, destination)).rejects.toThrow("Evidence-volume export failed");
      await expect(operations.recover(recoverRequest, destination)).rejects.toThrow("Evidence-volume export failed");
    }
  });

  it("redacts non-Error failures and rejects unproven volume journal authority", async () => {
    const nonErrorJournal = { ...journal, reserve: async () => { throw "private-sentinel"; } };
    const nonErrorOptions = mutate((value) => { value.journal = nonErrorJournal; });
    await expect(createEvidenceExportOperations(nonErrorOptions)
      .execute(exportRequest, "/tmp/match.tar")).rejects.toThrow("Evidence-volume export failed");

    for (const runId of ["run-two", "run-one"]) {
      const unprovenJournal = {
        ...journal,
        read: async () => ({
          descriptor_digest: digest,
          entries: [],
          revision: 0,
          run_id: runId,
          selected_target: target,
          version: "spawnfile.target-resource.journal.v1",
        }),
        reserve: async () => ({
          claim: { operationHandle, requestDigest },
          kind: "owner",
        }),
      };
      const options = mutate((value) => { value.journal = unprovenJournal; });
      await expect(createEvidenceExportOperations(options)
        .execute(exportRequest, "/tmp/match.tar")).rejects.toThrow("Evidence-volume export failed");
    }
  });
});
