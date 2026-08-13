import { SpawnfileError } from "../shared/index.js";

import {
  parseTargetResourceRequest,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import { type TargetLocalBundlePrivateMapping, type TargetLocalBundleStore } from "./containerBundleStore.js";
import { attestTargetLocalBundleMapping, type DockerTargetLocalBundleBuilder } from "./containerBundle.js";
import {
  createDockerConfigArtifactSpec,
  type DockerConfigArtifactIdentityBinding,
  type DockerArtifactIdentityStore
} from "./dockerArtifactsProvider.js";
import { createTargetReceiptDigest } from "./handles.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";

export const DOCKER_PREPARED_ARTIFACT_ERROR = "Docker artifact resolution failed";
type ArtifactRequest = Extract<TargetResourceRequest, { operation: "resolve_world_artifact" }>;
type ArtifactResult = { readonly receipt: TargetResourceReceipt; readonly receiptBytes: string };
export interface PreparedArtifactAuthorityMapping {
  readonly archive_digest: string;
  readonly artifact_manifest_digest: string;
  readonly base_image_config_digest: string;
  readonly build_policy_digest: string;
  readonly bundle_digest: string;
  readonly entrypoint: string;
  readonly launcher_digest: string;
  readonly network_alias: string;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly platform_digest: string;
}

export interface DockerPreparedArtifactOperations {
  execute(raw: unknown): Promise<ArtifactResult>;
}
const fail = (): never => { throw new SpawnfileError("runtime_error", DOCKER_PREPARED_ARTIFACT_ERROR); };
/**
 * Reconstructs the prepared-image authority without ever substituting the
 * later resolution claim for the preparation claim that minted its GC anchor.
 */
export const attestPreparedArtifactIdentity = async (
  builder: DockerTargetLocalBundleBuilder,
  binding: DockerConfigArtifactIdentityBinding,
  prepared: TargetLocalBundlePrivateMapping,
  selectedTarget: ArtifactRequest["selected_target"]
): Promise<void> => {
  const expected: TargetLocalBundlePrivateMapping = {
    archive_digest: binding.archiveDigest,
    artifact_digest: binding.artifactManifestDigest,
    base_image_config_digest: binding.baseImageConfigDigest,
    build_policy_digest: binding.buildPolicyDigest,
    bundle_digest: binding.bundleDigest,
    config_id: binding.configId,
    daemon_epoch: binding.daemonEpoch,
    entrypoint: binding.entrypoint,
    gc_tag: binding.gcTag,
    identity_kind: binding.identityKind,
    launcher_digest: binding.launcherDigest,
    network_alias: binding.networkAlias,
    operation_handle: binding.preparedOperationHandle,
    platform: binding.platform,
    platform_digest: binding.platformDigest,
    request_digest: binding.preparedRequestDigest,
    selected_target: selectedTarget
  };
  if (JSON.stringify(prepared) !== JSON.stringify(expected)) return fail();
  await attestTargetLocalBundleMapping(builder, prepared);
};
const request = (raw: unknown): ArtifactRequest => {
  const parsed = parseTargetResourceRequest(raw);
  if (parsed.operation !== "resolve_world_artifact") return fail();
  return parsed;
};
const receipt = async (input: {
  readonly claim: TargetJournalClaim;
  readonly journal: TargetJournalStore;
  readonly labels: Readonly<Record<string, string>>;
  readonly request: ArtifactRequest;
  readonly resultHandle: string;
}): Promise<TargetResourceReceipt> => {
  const raw = {
    cleanup_state: "not_requested", descriptor_digest: input.request.descriptor_digest,
    export_state: "not_requested", labels: Object.entries(input.labels).map(([key, value]) => ({ key, value })),
    operation: input.request.operation, operation_handle: input.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: input.claim.requestDigest,
    result_handle: input.resultHandle, resulting_revision: (await input.journal.read()).revision + 1,
    run_id: input.request.run_id, selected_target: input.request.selected_target,
    version: "spawnfile.target-resource.receipt.v1"
  };
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) } as TargetResourceReceipt;
};

/**
 * Private target-default lowering.  It admits an already prepared local image
 * only through the bundle store's exact selected-target/correlation lookup.
 */
export const createDockerPreparedArtifactOperations = (input: {
  readonly identityStore: DockerArtifactIdentityStore;
  readonly builder: DockerTargetLocalBundleBuilder;
  readonly journal: TargetJournalStore;
  readonly mapping: PreparedArtifactAuthorityMapping;
  readonly store: TargetLocalBundleStore;
}): DockerPreparedArtifactOperations => {
  if (!input?.identityStore || !input.builder || !input.journal || !input.mapping || !input.store) fail();
  const execute = async (raw: unknown): Promise<ArtifactResult> => {
    try {
      const value = request(raw);
      if (value.artifact_manifest_digest !== input.mapping.artifact_manifest_digest) return fail();
      const reservation = await input.journal.reserve(value);
      if (reservation.kind === "replay") return { receipt: reservation.receipt, receiptBytes: reservation.receiptBytes };
      const prepared = await input.store.resolvePrepared({
        artifact_digest: value.artifact_manifest_digest,
        build_policy_digest: input.mapping.build_policy_digest,
        bundle_digest: input.mapping.bundle_digest,
        selected_target: value.selected_target
      });
      if (!prepared || prepared.request.selected_target.handle !== value.selected_target.handle
        || prepared.request.selected_target.fingerprint !== value.selected_target.fingerprint
        || prepared.request.artifact_digest !== value.artifact_manifest_digest
        || prepared.mapping.archive_digest !== input.mapping.archive_digest
        || prepared.mapping.base_image_config_digest !== input.mapping.base_image_config_digest
        || prepared.request.bundle_digest !== input.mapping.bundle_digest
        || prepared.request.build_policy_digest !== input.mapping.build_policy_digest
        || prepared.mapping.entrypoint !== input.mapping.entrypoint
        || prepared.request.launcher_digest !== input.mapping.launcher_digest
        || prepared.request.network_alias !== input.mapping.network_alias
        || prepared.request.platform_digest !== input.mapping.platform_digest
        || JSON.stringify(prepared.request.platform) !== JSON.stringify(input.mapping.platform)
        || prepared.mapping.artifact_digest !== value.artifact_manifest_digest
        || prepared.mapping.build_policy_digest !== input.mapping.build_policy_digest
        || prepared.mapping.bundle_digest !== input.mapping.bundle_digest
        || prepared.mapping.launcher_digest !== input.mapping.launcher_digest
        || prepared.mapping.network_alias !== input.mapping.network_alias
        || prepared.mapping.platform_digest !== input.mapping.platform_digest
        || JSON.stringify(prepared.mapping.platform) !== JSON.stringify(input.mapping.platform)) return fail();
      await attestTargetLocalBundleMapping(input.builder, prepared.mapping);
      const spec = createDockerConfigArtifactSpec({
        archiveDigest: input.mapping.archive_digest,
        artifactManifestDigest: value.artifact_manifest_digest,
        baseImageConfigDigest: input.mapping.base_image_config_digest,
        buildPolicyDigest: input.mapping.build_policy_digest,
        bundleDigest: input.mapping.bundle_digest, configId: prepared.mapping.config_id,
        daemonEpoch: prepared.mapping.daemon_epoch, entrypoint: input.mapping.entrypoint,
        launcherDigest: input.mapping.launcher_digest, networkAlias: input.mapping.network_alias,
        operationHandle: reservation.claim.operationHandle, requestDigest: reservation.claim.requestDigest,
        selectedTargetHandle: value.selected_target.handle, platform: input.mapping.platform,
        platformDigest: input.mapping.platform_digest
      });
      await input.identityStore.bind({
        archiveDigest: input.mapping.archive_digest,
        artifactManifestDigest: value.artifact_manifest_digest,
        baseImageConfigDigest: input.mapping.base_image_config_digest,
        buildPolicyDigest: input.mapping.build_policy_digest,
        bundleDigest: input.mapping.bundle_digest, configId: prepared.mapping.config_id,
        daemonEpoch: prepared.mapping.daemon_epoch, entrypoint: input.mapping.entrypoint, gcTag: prepared.mapping.gc_tag,
        identityKind: "docker_image_config_digest", operationHandle: reservation.claim.operationHandle,
        launcherDigest: input.mapping.launcher_digest, networkAlias: input.mapping.network_alias,
        preparedOperationHandle: prepared.mapping.operation_handle,
        preparedRequestDigest: prepared.mapping.request_digest,
        requestDigest: reservation.claim.requestDigest, resultHandle: spec.resultHandle,
        selectedTargetHandle: value.selected_target.handle, platform: input.mapping.platform,
        platformDigest: input.mapping.platform_digest
      });
      return input.journal.complete(reservation.claim, await receipt({ claim: reservation.claim,
        journal: input.journal, labels: spec.labels, request: value, resultHandle: spec.resultHandle }));
    } catch { return fail(); }
  };
  return Object.freeze({ execute });
};
