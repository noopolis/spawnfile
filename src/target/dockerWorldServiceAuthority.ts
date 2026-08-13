import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  parseRunId,
  parseSelectedTargetReceipt,
  type OpaqueTargetHandle
} from "./contracts.js";
import {
  createDockerArtifactSpec,
  createDockerConfigArtifactSpec,
  type DockerArtifactSpec
} from "./dockerArtifactsProvider.js";

export const WORLD_SERVICE_AUTHORIZATION_VERSION =
  "spawnfile.target-world-service.authorization.v1" as const;
export const WORLD_SERVICE_ERROR = "Docker world-service lifecycle failed";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{32}$/u;

export interface WorldServiceAuthorization {
  readonly data_network_handle: OpaqueTargetHandle;
  readonly descriptor_digest: string;
  readonly evidence_mount_path: string;
  readonly evidence_volume_handle: OpaqueTargetHandle;
  readonly operation_handle: OpaqueTargetHandle;
  readonly request_digest: string;
  readonly run_id: string;
  readonly secret_bindings_handle: OpaqueTargetHandle;
  readonly selected_target: {
    readonly fingerprint: string;
    readonly handle: OpaqueTargetHandle;
  };
  readonly version: typeof WORLD_SERVICE_AUTHORIZATION_VERSION;
  readonly world_artifact_handle: OpaqueTargetHandle;
}

export interface ResolvedOciWorldArtifactBinding {
  readonly artifact_manifest_digest: string;
  /** Legacy in-memory fixtures may omit this; parsed authority packets may not. */
  readonly identity_kind?: "oci_image_manifest";
  readonly image_digest: string;
  readonly image_reference: string;
  readonly operation_handle: OpaqueTargetHandle;
  readonly request_digest: string;
  readonly result_handle: OpaqueTargetHandle;
}
export interface ResolvedConfigWorldArtifactBinding {
  readonly archive_digest: string;
  readonly artifact_manifest_digest: string;
  readonly base_image_config_digest: string;
  readonly build_policy_digest: string;
  readonly bundle_digest: string;
  readonly config_id: string;
  readonly daemon_epoch: string;
  readonly entrypoint: string;
  readonly gc_tag: string;
  readonly identity_kind: "docker_image_config_digest";
  readonly image_digest: string;
  readonly image_reference: string;
  readonly launcher_digest: string;
  readonly network_alias: string;
  readonly operation_handle: OpaqueTargetHandle;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly platform_digest: string;
  readonly prepared_operation_handle: OpaqueTargetHandle;
  readonly prepared_request_digest: string;
  readonly request_digest: string;
  readonly result_handle: OpaqueTargetHandle;
}
export type ResolvedWorldArtifactBinding =
  | ResolvedOciWorldArtifactBinding
  | ResolvedConfigWorldArtifactBinding;

export interface WorldServiceResolution {
  readonly artifact: ResolvedWorldArtifactBinding;
  readonly authorization: WorldServiceAuthorization;
}

export interface WorldServiceResolver {
  resolve(input: {
    readonly authorization: WorldServiceAuthorization;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

const fail = (): never => { throw new Error(WORLD_SERVICE_ERROR); };
const ordinary = (raw: unknown): void => {
  try { assertOrdinaryJsonGraph(raw); } catch { return fail(); }
};
const record = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
  && Object.getPrototypeOf(raw) === Object.prototype;
const exactKeys = (raw: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(raw).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
};
const digest = (raw: unknown): string => {
  if (typeof raw !== "string" || !DIGEST_PATTERN.test(raw)) return fail();
  return raw;
};
const containerPath = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length > 255
    || !/^\/(?:run|var\/lib)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(raw) || raw.includes("//")
    || raw.endsWith("/") || raw.split("/").some((part) => part === "." || part === "..")
    || raw === "/run/spawnfile-secrets" || raw.startsWith("/run/spawnfile-secrets/")
    || "/run/spawnfile-secrets".startsWith(`${raw}/`)) return fail();
  return raw;
};

export const createWorldServiceAuthorization = (input: {
  readonly dataNetworkHandle: unknown;
  readonly descriptorDigest: unknown;
  readonly evidenceMountPath: unknown;
  readonly evidenceVolumeHandle: unknown;
  readonly operationHandle: unknown;
  readonly requestDigest: unknown;
  readonly runId: unknown;
  readonly secretBindingsHandle: unknown;
  readonly selectedTarget: unknown;
  readonly worldArtifactHandle: unknown;
}): WorldServiceAuthorization => {
  try {
    const selected = parseSelectedTargetReceipt({
      ...(record(input.selectedTarget) ? input.selectedTarget : {}),
      version: "spawnfile.target-resource.selected-target.v1"
    });
    return Object.freeze({
      data_network_handle: parseOpaqueTargetHandle(input.dataNetworkHandle),
      descriptor_digest: digest(input.descriptorDigest),
      evidence_mount_path: containerPath(input.evidenceMountPath),
      evidence_volume_handle: parseOpaqueTargetHandle(input.evidenceVolumeHandle),
      operation_handle: parseOpaqueTargetHandle(input.operationHandle),
      request_digest: digest(input.requestDigest),
      run_id: parseRunId(input.runId),
      secret_bindings_handle: parseOpaqueTargetHandle(input.secretBindingsHandle),
      selected_target: Object.freeze({
        fingerprint: selected.fingerprint,
        handle: selected.handle
      }),
      version: WORLD_SERVICE_AUTHORIZATION_VERSION,
      world_artifact_handle: parseOpaqueTargetHandle(input.worldArtifactHandle)
    });
  } catch { return fail(); }
};

export const parseWorldServiceAuthorization = (
  raw: unknown
): WorldServiceAuthorization => {
  try {
    ordinary(raw);
    if (!record(raw) || !exactKeys(raw, [
      "data_network_handle", "descriptor_digest", "evidence_mount_path", "evidence_volume_handle",
      "operation_handle", "request_digest", "run_id", "secret_bindings_handle",
      "selected_target", "version", "world_artifact_handle"
    ]) || raw.version !== WORLD_SERVICE_AUTHORIZATION_VERSION
      || !record(raw.selected_target)
      || !exactKeys(raw.selected_target, ["fingerprint", "handle"])
      || typeof raw.selected_target.fingerprint !== "string"
      || !FINGERPRINT_PATTERN.test(raw.selected_target.fingerprint)) return fail();
    return createWorldServiceAuthorization({
      dataNetworkHandle: raw.data_network_handle,
      descriptorDigest: raw.descriptor_digest,
      evidenceMountPath: raw.evidence_mount_path,
      evidenceVolumeHandle: raw.evidence_volume_handle,
      operationHandle: raw.operation_handle,
      requestDigest: raw.request_digest,
      runId: raw.run_id,
      secretBindingsHandle: raw.secret_bindings_handle,
      selectedTarget: raw.selected_target,
      worldArtifactHandle: raw.world_artifact_handle
    });
  } catch { return fail(); }
};

const parseArtifact = (
  raw: unknown,
  authorization: WorldServiceAuthorization
): ResolvedWorldArtifactBinding => {
  if (!record(raw) || raw.identity_kind !== undefined && typeof raw.identity_kind !== "string") return fail();
  let artifact: ResolvedWorldArtifactBinding; let spec: DockerArtifactSpec | ReturnType<typeof createDockerConfigArtifactSpec>;
  try {
    if (raw.identity_kind === "oci_image_manifest" || raw.identity_kind === undefined) {
      const legacy = raw.identity_kind === undefined;
      if (!exactKeys(raw, legacy ? ["artifact_manifest_digest", "image_digest", "image_reference", "operation_handle", "request_digest", "result_handle"]
        : ["artifact_manifest_digest", "identity_kind", "image_digest", "image_reference", "operation_handle", "request_digest", "result_handle"])) return fail();
      artifact = Object.freeze({ artifact_manifest_digest: digest(raw.artifact_manifest_digest),
        identity_kind: "oci_image_manifest" as const, image_digest: digest(raw.image_digest),
        image_reference: typeof raw.image_reference === "string" ? raw.image_reference : fail(),
        operation_handle: parseOpaqueTargetHandle(raw.operation_handle), request_digest: digest(raw.request_digest),
        result_handle: parseOpaqueTargetHandle(raw.result_handle) });
      spec = createDockerArtifactSpec({ artifactManifestDigest: artifact.artifact_manifest_digest,
        imageDigest: artifact.image_digest, imageReference: artifact.image_reference,
        operationHandle: artifact.operation_handle, requestDigest: artifact.request_digest,
        selectedTargetHandle: authorization.selected_target.handle });
    } else if (raw.identity_kind === "docker_image_config_digest") {
      if (!exactKeys(raw, ["archive_digest", "artifact_manifest_digest", "base_image_config_digest",
        "build_policy_digest", "bundle_digest", "config_id", "daemon_epoch", "entrypoint", "gc_tag", "identity_kind",
        "image_digest", "image_reference", "launcher_digest", "network_alias", "operation_handle", "platform",
        "platform_digest", "prepared_operation_handle", "prepared_request_digest", "request_digest", "result_handle"])) return fail();
      const configId = digest(raw.config_id);
      const platform = raw.platform;
      if (!record(platform) || !exactKeys(platform, ["architecture", "os"])
        || (platform.architecture !== "amd64" && platform.architecture !== "arm64") || platform.os !== "linux"
        || typeof raw.entrypoint !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(raw.entrypoint)
        || raw.entrypoint.includes("//") || raw.entrypoint.split("/").some((part) => part === "." || part === "..")
        || typeof raw.network_alias !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(raw.network_alias)) return fail();
      artifact = Object.freeze({ archive_digest: digest(raw.archive_digest),
        artifact_manifest_digest: digest(raw.artifact_manifest_digest),
        base_image_config_digest: digest(raw.base_image_config_digest),
        build_policy_digest: digest(raw.build_policy_digest), bundle_digest: digest(raw.bundle_digest),
        config_id: configId, daemon_epoch: digest(raw.daemon_epoch), entrypoint: raw.entrypoint,
        gc_tag: typeof raw.gc_tag === "string" && /^spfb_[a-f0-9]{58}$/u.test(raw.gc_tag) ? raw.gc_tag : fail(),
        identity_kind: "docker_image_config_digest" as const,
        image_digest: digest(raw.image_digest), image_reference: typeof raw.image_reference === "string" ? raw.image_reference : fail(),
        launcher_digest: digest(raw.launcher_digest), network_alias: raw.network_alias,
        operation_handle: parseOpaqueTargetHandle(raw.operation_handle), request_digest: digest(raw.request_digest),
        prepared_operation_handle: parseOpaqueTargetHandle(raw.prepared_operation_handle),
        prepared_request_digest: digest(raw.prepared_request_digest),
        result_handle: parseOpaqueTargetHandle(raw.result_handle),
        platform: Object.freeze({ architecture: platform.architecture, os: platform.os }),
        platform_digest: digest(raw.platform_digest) });
      if (artifact.image_digest !== configId || artifact.image_reference !== configId) return fail();
      spec = createDockerConfigArtifactSpec({ archiveDigest: artifact.archive_digest,
        artifactManifestDigest: artifact.artifact_manifest_digest,
        baseImageConfigDigest: artifact.base_image_config_digest,
        buildPolicyDigest: artifact.build_policy_digest, bundleDigest: artifact.bundle_digest,
        configId, daemonEpoch: artifact.daemon_epoch, entrypoint: artifact.entrypoint,
        launcherDigest: artifact.launcher_digest, networkAlias: artifact.network_alias,
        operationHandle: artifact.operation_handle, requestDigest: artifact.request_digest,
        selectedTargetHandle: authorization.selected_target.handle, platform: artifact.platform,
        platformDigest: artifact.platform_digest });
    } else return fail();
  } catch { return fail(); }
  if (spec.resultHandle !== artifact.result_handle
    || artifact.result_handle !== authorization.world_artifact_handle) return fail();
  return artifact;
};

export const parseWorldServiceResolution = (raw: unknown): WorldServiceResolution => {
  try {
    ordinary(raw);
    if (!record(raw) || !exactKeys(raw, ["artifact", "authorization"])) return fail();
    const authorization = parseWorldServiceAuthorization(raw.authorization);
    return Object.freeze({
      artifact: parseArtifact(raw.artifact, authorization),
      authorization
    });
  } catch { return fail(); }
};
