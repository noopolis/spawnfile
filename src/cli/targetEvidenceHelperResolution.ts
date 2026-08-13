import { createHash } from "node:crypto";

import {
  parseTargetResourceRequest,
  type TargetResourceRequest,
} from "../target/contracts.js";

type EvidenceExportRequest = Extract<TargetResourceRequest, {
  operation: "export_evidence_volume";
}>;
type ArtifactResolutionRequest = Extract<TargetResourceRequest, {
  operation: "resolve_world_artifact";
}>;

/**
 * Derives the target-owned helper admission immediately preceding an evidence
 * export. The public export revision therefore names the second mutation in
 * this aggregate operation; recovery reuses the completed admission.
 */
export const createTargetEvidenceHelperResolutionRequest = (
  request: EvidenceExportRequest,
  artifactManifestDigest: string,
): ArtifactResolutionRequest => {
  if (request.expected_revision < 1) throw new Error("Target operation mismatch");
  return parseTargetResourceRequest({
    artifact_manifest_digest: artifactManifestDigest,
    descriptor_digest: request.descriptor_digest,
    expected_revision: request.expected_revision - 1,
    idempotency_key: `idem_${createHash("sha256")
      .update("spawnfile.target-evidence-helper-resolution.v1\0", "utf8")
      .update(request.idempotency_key, "utf8").digest("hex").slice(0, 32)}`,
    operation: "resolve_world_artifact",
    run_id: request.run_id,
    selected_target: request.selected_target,
    version: "spawnfile.target-resource.request.v1",
  }) as ArtifactResolutionRequest;
};
