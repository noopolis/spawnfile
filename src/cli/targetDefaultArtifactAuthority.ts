import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import type { DockerArtifactIdentityBinding, DockerArtifactIdentityStore, DockerArtifactMapping } from "../target/dockerArtifactsProvider.js";
import type { TargetJournalStore } from "../target/journal.js";

const fail = (): never => { throw new Error("Target authority initialization failed"); };

export const completedTargetArtifacts = async (journal: TargetJournalStore, identities: DockerArtifactIdentityStore): Promise<readonly DockerArtifactIdentityBinding[]> => {
  const snapshot = await journal.read(); const bindings: DockerArtifactIdentityBinding[] = [];
  for (const entry of snapshot.entries) {
    if (entry.operation !== "resolve_world_artifact" || entry.state !== "completed") continue;
    const completed = await journal.resolveCompletedReceipt({ operationHandle: entry.operation_handle, requestDigest: entry.request_digest as `sha256:${string}` });
    if (!completed || completed.receipt.operation !== "resolve_world_artifact" || completed.receipt.operation_handle !== entry.operation_handle
      || completed.receipt.request_digest !== entry.request_digest || completed.receipt.result_handle === null) return fail();
    const binding = await identities.resolveOperation(entry.operation_handle, entry.request_digest);
    if (!binding || binding.operationHandle !== entry.operation_handle || binding.requestDigest !== entry.request_digest
      || binding.resultHandle !== completed.receipt.result_handle || binding.selectedTargetHandle !== snapshot.selected_target.handle) return fail();
    bindings.push(binding);
  }
  return Object.freeze(bindings);
};
export const exactTargetArtifactMapping = (config: TargetDefaultConfig, binding: DockerArtifactIdentityBinding): DockerArtifactMapping => {
  if (binding.identityKind !== "oci_image_manifest") return fail();
  const matches = config.artifactMappings.filter((mapping) => mapping.artifact_manifest_digest === binding.artifactManifestDigest
    && mapping.image_digest === binding.imageDigest && mapping.image_reference === binding.imageReference);
  if (matches.length !== 1) return fail(); return matches[0]!;
};
