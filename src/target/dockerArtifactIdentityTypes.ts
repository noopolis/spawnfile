import type { OpaqueTargetHandle } from "./contracts.js";

export interface DockerOciArtifactIdentityBinding {
  readonly artifactManifestDigest: string;
  /** Omitted only at the in-process writer API; persisted records always carry it. */
  readonly identityKind?: "oci_image_manifest";
  readonly imageDigest: string;
  readonly imageReference: string;
  readonly operationHandle: OpaqueTargetHandle;
  readonly requestDigest: string;
  readonly resultHandle: OpaqueTargetHandle;
  readonly selectedTargetHandle: OpaqueTargetHandle;
}

export interface DockerConfigArtifactIdentityBinding {
  readonly archiveDigest: string;
  readonly artifactManifestDigest: string;
  readonly baseImageConfigDigest: string;
  readonly buildPolicyDigest: string;
  readonly bundleDigest: string;
  readonly configId: string;
  readonly daemonEpoch: string;
  readonly entrypoint: string;
  /** Private deterministic GC anchor paired with this local config identity. */
  readonly gcTag: string;
  readonly identityKind: "docker_image_config_digest";
  readonly launcherDigest: string;
  readonly networkAlias: string;
  readonly operationHandle: OpaqueTargetHandle;
  readonly requestDigest: string;
  readonly resultHandle: OpaqueTargetHandle;
  readonly selectedTargetHandle: OpaqueTargetHandle;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly platformDigest: string;
  /** Exact bundle-prepare authority that minted gcTag/configId. */
  readonly preparedOperationHandle: OpaqueTargetHandle;
  readonly preparedRequestDigest: string;
}

/** Private authority only; persisted discriminator prevents variant confusion. */
export type DockerArtifactIdentityBinding =
  | DockerOciArtifactIdentityBinding
  | DockerConfigArtifactIdentityBinding;

export interface DockerArtifactIdentityStore {
  bind(input: DockerArtifactIdentityBinding): Promise<void>;
  /** Exact private lookup; there is intentionally no result inverse or listing API. */
  resolveOperation(
    operationHandle: OpaqueTargetHandle,
    requestDigest: string
  ): Promise<DockerArtifactIdentityBinding | null>;
}

export interface DockerArtifactIdentityStoreOptions {
  /** Test-only crash seam: runs after durable pending creation and before final linking. */
  readonly beforePublish?: () => Promise<void>;
  /** Test-only race seam after O_EXCL observes a pending name and before re-read. */
  readonly afterPendingExists?: () => Promise<void>;
  /** Test-only race seam after an exact pending proof and before its link attempt. */
  readonly beforeLink?: () => Promise<void>;
  /** Test-only crash seam: runs after the final link and before pending cleanup. */
  readonly afterLinkBeforePendingUnlink?: () => Promise<void>;
}
