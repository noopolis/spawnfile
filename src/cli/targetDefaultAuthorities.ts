import { initializeDockerArtifactIdentityStore, type DockerArtifactIdentityBinding, type DockerArtifactIdentityStore, type DockerArtifactMapping } from "../target/dockerArtifactsProvider.js";
import type { DockerArtifactExecutor } from "../target/dockerArtifactsProvider.js";
import { createPreparedEvidenceHelperExecutor } from "../evidenceExportHelper/index.js";
import { createDockerTargetExecutors, type DockerTargetExecutors } from "../target/dockerCommandExecutor.js";
import { initializeTargetSecretVersionAuthorityStore, type TargetSecretVersionAuthorityStore } from "../target/dockerSecretsAuthority.js";
import {
  parseWorldServiceAuthorization,
  parseWorldServiceResolution,
  type WorldServiceAuthorization,
  type WorldServiceResolver
} from "../target/dockerWorldServiceAuthority.js";
import {
  initializeWorldServiceAuthorityStore,
  type WorldServiceAuthorityStore
} from "../target/dockerWorldServiceStore.js";
import {
  initializeEvidenceExportAuthorityStore,
  type EvidenceExportAuthorityStore
} from "../target/evidenceExportStore.js";
import {
  initializeOrganizationAttachmentAuthorityStore,
  type OrganizationAttachmentAuthorityStore
} from "../target/organizationAttachmentStore.js";
import {
  createTargetTopologyAttestor,
  type TargetTopologyAttestor
} from "../target/topologyAttestation.js";
import {
  initializeTargetSecretSourceResolver
} from "../auth/targetSecretSourceResolver.js";
import type { TargetSecretSourceResolver } from "../target/dockerSecrets.js";
import { initializeOrganizationHandoffAuthorityStore, type OrganizationHandoffAuthorityStore } from "../deployment/organizationHandoffAuthorityStore.js";
import type { OrganizationAttachmentResolver } from "../target/organizationAttachmentAuthority.js";
import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import { completedTargetArtifacts, exactTargetArtifactMapping } from "./targetDefaultArtifactAuthority.js";
import { targetDefaultEnvelope as envelope } from "./targetDefaultEnvelope.js";
import { createDockerTargetLocalBundleBuilder } from "../target/dockerContainerBundleBuilder.js";
import { attestPreparedArtifactIdentity } from "../target/dockerPreparedArtifact.js";
import { initializeFilesystemTargetLocalBundleStore } from "../target/containerBundleFilesystemStore.js";
import {
  createTargetJournalAccess,
  TARGET_DEFAULT_AUTHORITIES_ERROR,
  type TargetJournalResolver
} from "./targetDefaultJournalAuthority.js";

export {
  TARGET_DEFAULT_AUTHORITIES_ERROR,
  type TargetJournalResolver,
  type TargetMutationAuthority
} from "./targetDefaultJournalAuthority.js";
const fail = (): never => { throw new Error(TARGET_DEFAULT_AUTHORITIES_ERROR); };
export interface HelperArtifactAuthority {
  readonly artifactIdentity: DockerArtifactIdentityBinding;
  readonly bundle: {
    readonly operation_handle: DockerArtifactIdentityBinding["operationHandle"];
    readonly request_digest: string;
    readonly result_handle: DockerArtifactIdentityBinding["resultHandle"];
  };
  readonly mapping: DockerArtifactMapping;
}
export interface HelperArtifactResolver {
  resolve(input: { readonly context: unknown; readonly request: unknown }): Promise<HelperArtifactAuthority>;
}
export interface TargetDefaultAuthorities {
  readonly artifactIdentityStore: DockerArtifactIdentityStore;
  readonly attachmentAuthorityStore: OrganizationAttachmentAuthorityStore;
  readonly evidenceExportAuthorityStore: EvidenceExportAuthorityStore;
  readonly executors: DockerTargetExecutors;
  readonly handoffResolver: OrganizationAttachmentResolver;
  readonly helperExecutor: DockerArtifactExecutor;
  /** Omitted when this invocation cannot export evidence. */
  readonly helperArtifactResolver?: HelperArtifactResolver;
  readonly journals: TargetJournalResolver;
  readonly secretAuthorityStore: TargetSecretVersionAuthorityStore;
  readonly secretResolver: TargetSecretSourceResolver;
  readonly topologyAttestor: TargetTopologyAttestor;
  readonly worldAuthorityStore: WorldServiceAuthorityStore;
  readonly worldResolver: WorldServiceResolver;
}

/**
 * The production authority graph owns B114 worker clients and directory file
 * handles.  It is therefore deliberately a session, rather than an ambient
 * process singleton: the caller that starts the graph must close it.
 */
export interface TargetDefaultAuthoritySession {
  readonly authorities: TargetDefaultAuthorities;
  dispose(): Promise<void>;
}

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const initializeTargetDefaultAuthoritySession = async (
  config: TargetDefaultConfig
): Promise<TargetDefaultAuthoritySession> => {
  let handoffAuthority: OrganizationHandoffAuthorityStore | undefined;
  try {
    const journalAccess = createTargetJournalAccess(config);
    const journals = journalAccess.resolver;
    const [
      artifactIdentityStore,
      secretAuthorityStore,
      attachmentAuthorityStore,
      worldAuthorityStore,
      evidenceExportAuthorityStore,
      secretResolver
    ] = await Promise.all([
      initializeDockerArtifactIdentityStore(config.paths.artifactIdentities),
      initializeTargetSecretVersionAuthorityStore(config.paths.secretAuthority),
      initializeOrganizationAttachmentAuthorityStore(config.paths.attachmentAuthority),
      initializeWorldServiceAuthorityStore(config.paths.worldAuthority),
      initializeEvidenceExportAuthorityStore(config.paths.evidenceExport),
      // Production always resolves grants from the B113 host-local authority
      // store.  It deliberately has no configuration or ambient override seam.
      initializeTargetSecretSourceResolver()
    ]);
    // The B114 store owns its anchored filesystem workers.  Keep the store
    // alive through its resolver rather than accepting a caller-provided one.
    handoffAuthority = await initializeOrganizationHandoffAuthorityStore();
    const handoffResolver = handoffAuthority.resolver as OrganizationAttachmentResolver;
    const executors = createDockerTargetExecutors({ dockerCommand: config.dockerCommand });
    const helperExecutor = createPreparedEvidenceHelperExecutor(config.dockerCommand);
    const preparedBuilder = createDockerTargetLocalBundleBuilder({ context: config.context,
      executor: executors.artifact, timeoutMs: config.timeoutMs });
    const preparedStore = await initializeFilesystemTargetLocalBundleStore(config.paths.containerBundles);
    const worldResolver: WorldServiceResolver = Object.freeze({
    resolve: async (raw: {
      readonly authorization: WorldServiceAuthorization;
      readonly signal?: AbortSignal;
    }) => {
      const input = envelope(raw, ["authorization"], ["signal"]);
      let authorization;
      try { authorization = parseWorldServiceAuthorization(input.authorization); }
      catch { return fail(); }
      const journal = await journalAccess.resolveIdentity({
        context: config.context,
        descriptorDigest: authorization.descriptor_digest,
        runId: authorization.run_id,
        selectedTarget: authorization.selected_target
      });
      const bindings = (await completedTargetArtifacts(journal, artifactIdentityStore))
        .filter((binding) => binding.resultHandle === authorization.world_artifact_handle);
      if (bindings.length !== 1) return fail();
      const binding = bindings[0]!;
      try {
        let artifact: Record<string, unknown>;
        if (binding.identityKind === "oci_image_manifest") {
          artifact = {
            artifact_manifest_digest: binding.artifactManifestDigest,
            identity_kind: binding.identityKind,
            image_digest: binding.imageDigest,
            image_reference: binding.imageReference,
            operation_handle: binding.operationHandle,
            request_digest: binding.requestDigest,
            result_handle: binding.resultHandle
          };
        } else if (binding.identityKind === "docker_image_config_digest") {
          const prepared = await preparedStore.resolve({
            operation_handle: binding.preparedOperationHandle,
            request_digest: binding.preparedRequestDigest
          });
          if (!prepared || !same(prepared, {
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
            selected_target: authorization.selected_target
          })) return fail();
          await attestPreparedArtifactIdentity(preparedBuilder, binding, prepared, authorization.selected_target);
          artifact = {
            archive_digest: binding.archiveDigest,
            artifact_manifest_digest: binding.artifactManifestDigest,
            base_image_config_digest: binding.baseImageConfigDigest,
            build_policy_digest: binding.buildPolicyDigest,
            bundle_digest: binding.bundleDigest,
            config_id: binding.configId,
            daemon_epoch: binding.daemonEpoch,
            entrypoint: binding.entrypoint,
            gc_tag: binding.gcTag,
            identity_kind: binding.identityKind,
            image_digest: binding.configId,
            image_reference: binding.configId,
            launcher_digest: binding.launcherDigest,
            network_alias: binding.networkAlias,
            operation_handle: binding.operationHandle,
            platform: binding.platform,
            platform_digest: binding.platformDigest,
            prepared_operation_handle: binding.preparedOperationHandle,
            prepared_request_digest: binding.preparedRequestDigest,
            request_digest: binding.requestDigest,
            result_handle: binding.resultHandle
          };
        } else return fail();
        return parseWorldServiceResolution({
          artifact,
          authorization
        });
      } catch { return fail(); }
    }
  });
    const helperArtifactResolver: HelperArtifactResolver | undefined = config.helperArtifact
      ? Object.freeze({
    resolve: async (raw: {
      readonly context: unknown;
      readonly request: unknown;
    }) => {
      const input = envelope(raw, ["context", "request"]);
      const authority = await journals.resolve({
        context: input.context,
        request: input.request
      });
      const bindings = (await completedTargetArtifacts(authority.journal, artifactIdentityStore))
        .filter((binding) =>
          binding.identityKind === "oci_image_manifest"
          && binding.artifactManifestDigest === config.helperArtifact!.artifact_manifest_digest);
      if (bindings.length !== 1) return fail();
      const artifactIdentity = bindings[0]!;
      if (artifactIdentity.identityKind !== "oci_image_manifest") return fail();
      const mapping = exactTargetArtifactMapping(config, artifactIdentity);
      return Object.freeze({
        artifactIdentity,
        bundle: Object.freeze({
          operation_handle: artifactIdentity.operationHandle,
          request_digest: artifactIdentity.requestDigest,
          result_handle: artifactIdentity.resultHandle
        }),
        mapping
      });
    }
  }) : undefined;
    const topologyAttestor = createTargetTopologyAttestor({
      attachmentExecutor: executors.attachment,
      attachmentStore: attachmentAuthorityStore,
      context: config.context,
      resolveJournal: async (input) => journalAccess.resolveExistingIdentity({
        context: config.context,
        descriptorDigest: input.descriptorDigest,
        runId: input.runId,
        selectedTarget: input.selectedTarget
      }),
      resourceExecutor: executors.resource,
      timeoutMs: config.timeoutMs,
      worldExecutor: executors.world,
      worldStore: worldAuthorityStore
    });
    const authorities = Object.freeze({
      artifactIdentityStore,
      attachmentAuthorityStore,
      evidenceExportAuthorityStore,
      executors,
      handoffResolver,
      helperExecutor,
      ...(helperArtifactResolver ? { helperArtifactResolver } : {}),
      journals,
      secretAuthorityStore,
      secretResolver,
      topologyAttestor,
      worldAuthorityStore,
      worldResolver
    });
    let disposal: Promise<void> | undefined;
    const dispose = async (): Promise<void> => {
      disposal ??= handoffAuthority!.dispose();
      await disposal;
    };
    return Object.freeze({ authorities, dispose });
  } catch {
    // Do not orphan B114's worker clients if a later authority fails to
    // initialize.  A successfully-created session transfers that ownership
    // to its explicit disposer instead.
    await handoffAuthority?.dispose().catch(() => undefined);
    return fail();
  }
};
