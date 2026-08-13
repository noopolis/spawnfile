import { describe, expect, it } from "vitest";

import { parseTargetResourceRequest } from "../target/contracts.js";
import { createTargetEvidenceHelperResolutionRequest } from
  "./targetEvidenceHelperResolution.js";

const exportRequest = (expectedRevision: number) => parseTargetResourceRequest({
  descriptor_digest: `sha256:${"d".repeat(64)}`,
  evidence_volume_handle: "opaque_evidencevolume01",
  expected_revision: expectedRevision,
  idempotency_key: "idem_exportevidence01",
  operation: "export_evidence_volume",
  run_id: "run-one",
  selected_target: {
    fingerprint: `sha256:${"f".repeat(32)}`,
    handle: "opaque_selectedtarget01",
  },
  version: "spawnfile.target-resource.request.v1",
});

describe("target evidence-helper resolution request", () => {
  it("binds one deterministic immediately preceding mutation", () => {
    const first = createTargetEvidenceHelperResolutionRequest(
      exportRequest(7) as Extract<ReturnType<typeof exportRequest>, {
        operation: "export_evidence_volume";
      }>,
      `sha256:${"a".repeat(64)}`,
    );
    const second = createTargetEvidenceHelperResolutionRequest(
      exportRequest(7) as Extract<ReturnType<typeof exportRequest>, {
        operation: "export_evidence_volume";
      }>,
      `sha256:${"a".repeat(64)}`,
    );
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      artifact_manifest_digest: `sha256:${"a".repeat(64)}`,
      descriptor_digest: `sha256:${"d".repeat(64)}`,
      expected_revision: 6,
      idempotency_key: expect.stringMatching(/^idem_[a-f0-9]{32}$/u),
      operation: "resolve_world_artifact",
      run_id: "run-one",
    });
  });

  it("rejects an export revision with no preceding helper slot", () => {
    expect(() => createTargetEvidenceHelperResolutionRequest(
      exportRequest(0) as Extract<ReturnType<typeof exportRequest>, {
        operation: "export_evidence_volume";
      }>,
      `sha256:${"a".repeat(64)}`,
    )).toThrow("Target operation mismatch");
  });
});
