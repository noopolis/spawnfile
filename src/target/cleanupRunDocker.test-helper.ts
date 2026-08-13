import {
  createOrganizationHandoff,
  parseCanonicalSha256Digest
} from "../deployment/organizationHandoffTypes.js";
import {
  parseOpaqueTargetHandle,
  type OpaqueTargetHandle
} from "./contracts.js";
import { createDockerArtifactSpec } from "./dockerArtifactsProvider.js";
import {
  DockerSecretProviderError,
  createExistingDockerSecretSpec
} from "./dockerSecretsProvider.js";
import {
  DockerResourceProviderError,
  createDockerResourceSpec,
  type DockerResourceExecutor,
  type DockerResourceSpec
} from "./dockerResourcesProvider.js";
import {
  createWorldServiceAuthorization,
  parseWorldServiceResolution
} from "./dockerWorldServiceAuthority.js";
import {
  DockerWorldServiceProviderError,
  createDockerWorldServiceSpec
} from "./dockerWorldServiceProvider.js";
import {
  createWorldServiceBinding,
  type WorldServiceAuthorityStore,
  worldServiceResourceBindings
} from "./dockerWorldServiceStore.js";
import {
  createOrganizationAttachmentAuthorization,
  parseOrganizationAttachmentResolution
} from "./organizationAttachmentAuthority.js";
import {
  DockerOrganizationAttachmentProviderError,
  createDockerOrganizationAttachmentSpec
} from "./organizationAttachmentProvider.js";
import {
  createOrganizationAttachmentBinding,
  type OrganizationAttachmentAuthorityStore
} from "./organizationAttachmentStore.js";
import { type EvidenceExportAuthorityStore } from "./evidenceExportStore.js";

const deploymentLabels = {
  "com.spawnfile.compile_fingerprint": "sf1:compile",
  "com.spawnfile.deployment": "test-deployment",
  "com.spawnfile.project": "test-project",
  "com.spawnfile.run_id": "run-one",
  "com.spawnfile.unit": "world",
  "com.spawnfile.version": "0.1"
};

export const canonicalCleanupBindings = (input: {
  readonly attachmentOperationHandle: OpaqueTargetHandle;
  readonly attachmentRequestDigest: string;
  readonly descriptorDigest: string;
  readonly evidence: DockerResourceSpec;
  readonly evidenceOperationHandle: OpaqueTargetHandle;
  readonly evidenceRequestDigest: string;
  readonly network: DockerResourceSpec;
  readonly networkOperationHandle: OpaqueTargetHandle;
  readonly networkRequestDigest: string;
  readonly runId: string;
  readonly secretHandle: OpaqueTargetHandle;
  readonly selected: {
    readonly fingerprint: string;
    readonly handle: OpaqueTargetHandle;
  };
  readonly worldOperationHandle: OpaqueTargetHandle;
  readonly worldRequestDigest: string;
}) => {
  const artifact = createDockerArtifactSpec({
    artifactManifestDigest: `sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"b".repeat(64)}`,
    imageReference: `registry.example/world@sha256:${"b".repeat(64)}`,
    operationHandle: parseOpaqueTargetHandle("opaque_artifact00000001"),
    requestDigest: `sha256:${"3".repeat(64)}`,
    selectedTargetHandle: input.selected.handle
  });
  const worldAuthorization = createWorldServiceAuthorization({
    dataNetworkHandle: input.network.resultHandle,
    descriptorDigest: input.descriptorDigest,
    evidenceMountPath: "/run/world/evidence",
    evidenceVolumeHandle: input.evidence.resultHandle,
    operationHandle: input.worldOperationHandle,
    requestDigest: input.worldRequestDigest,
    runId: input.runId,
    secretBindingsHandle: input.secretHandle,
    selectedTarget: input.selected,
    worldArtifactHandle: artifact.resultHandle
  });
  const worldResolution = parseWorldServiceResolution({
    artifact: {
      artifact_manifest_digest: `sha256:${"a".repeat(64)}`,
      identity_kind: "oci_image_manifest" as const,
      image_digest: artifact.imageDigest,
      image_reference: artifact.imageReference,
      operation_handle: parseOpaqueTargetHandle("opaque_artifact00000001"),
      request_digest: `sha256:${"3".repeat(64)}`,
      result_handle: artifact.resultHandle
    },
    authorization: worldAuthorization
  });
  const worldResources = worldServiceResourceBindings({
    dataNetworkClaim: {
      operationHandle: input.networkOperationHandle,
      requestDigest: input.networkRequestDigest
    },
    evidenceVolumeClaim: {
      operationHandle: input.evidenceOperationHandle,
      requestDigest: input.evidenceRequestDigest
    },
    resolution: worldResolution
  });
  const resources = {
    ...worldResources,
    secret_bindings: (() => {
      const spec = createExistingDockerSecretSpec({
        bindingsHandle: input.secretHandle,
        runId: input.runId,
        selectedTargetHandle: input.selected.handle
      });
      return { handle: spec.resultHandle, labels: spec.labels, name: spec.volumeName };
    })()
  };
  const worldSpec = createDockerWorldServiceSpec({
    dataNetwork: resources.data_network,
    evidenceMountPath: worldAuthorization.evidence_mount_path,
    evidenceVolume: resources.evidence_volume,
    imageDigest: worldResolution.artifact.image_digest,
    imageReference: worldResolution.artifact.image_reference,
    operationHandle: worldAuthorization.operation_handle,
    requestDigest: worldAuthorization.request_digest,
    runId: input.runId,
    secretBindings: resources.secret_bindings,
    selectedTargetHandle: input.selected.handle
  });
  const world = createWorldServiceBinding({
    containerId: "c".repeat(64),
    dataNetwork: resources.data_network,
    evidenceVolume: resources.evidence_volume,
    resolution: worldResolution,
    secretBindings: resources.secret_bindings,
    spec: worldSpec
  });

  const attachmentAuthorization = createOrganizationAttachmentAuthorization({
    descriptorDigest: input.descriptorDigest,
    operationHandle: input.attachmentOperationHandle,
    organizationHandoffHandle: parseOpaqueTargetHandle("opaque_handoff000000001"),
    requestDigest: input.attachmentRequestDigest,
    runId: input.runId,
    selectedTarget: input.selected
  });
  const handoff = createOrganizationHandoff(input.runId, {
    bindingDigest: parseCanonicalSha256Digest(`sha256:${"4".repeat(64)}`),
    networkAttachmentHandle: parseOpaqueTargetHandle("opaque_networkattach001"),
    selectedTargetReceiptDigest:
      parseCanonicalSha256Digest(`sha256:${"5".repeat(64)}`)
  });
  const attachmentResolution = parseOrganizationAttachmentResolution({
    authorization: attachmentAuthorization,
    descriptor_binding: {
      binding_digest: handoff.binding_digest,
      descriptor_digest: input.descriptorDigest
    },
    handoff,
    network_attachment: {
      container_id: world.container_id,
      deployment_labels: deploymentLabels,
      network_attachment_handle: handoff.network_attachment_handle
    },
    selected_target_binding: {
      receipt: {
        ...input.selected,
        version: "spawnfile.target-resource.selected-target.v1"
      },
      receipt_digest: handoff.selected_target_receipt_digest
    }
  });
  const attachmentSpec = createDockerOrganizationAttachmentSpec({
    containerId: world.container_id,
    dataNetworkOperationHandle: input.networkOperationHandle,
    dataNetworkRequestDigest: input.networkRequestDigest,
    deploymentLabels,
    operationHandle: input.attachmentOperationHandle,
    organizationHandoffHandle: attachmentAuthorization.organization_handoff_handle,
    requestDigest: input.attachmentRequestDigest,
    runId: input.runId,
    selectedTargetHandle: input.selected.handle
  });
  const attachment = createOrganizationAttachmentBinding({
    dataNetworkOperationHandle: input.networkOperationHandle,
    dataNetworkRequestDigest: input.networkRequestDigest,
    networkId: "f".repeat(64),
    resolution: attachmentResolution,
    spec: attachmentSpec
  });
  return { attachment, world };
};

export const canonicalCleanupScenario = (
  input: Parameters<typeof canonicalCleanupBindings>[0]
) => {
  const bindings = canonicalCleanupBindings(input);
  const calls = {
    attachment: [] as string[][],
    secret: [] as string[][],
    world: [] as string[][]
  };
  const otherNetwork = createDockerResourceSpec({
    kind: "data_network",
    operationHandle: parseOpaqueTargetHandle("opaque_qqqqqqqqqqqqqqqq"),
    requestDigest: `sha256:${"a".repeat(64)}`,
    runId: input.runId,
    selectedTargetHandle: input.selected.handle
  });
  const drift = canonicalCleanupBindings({
    ...input,
    network: otherNetwork,
    networkOperationHandle: parseOpaqueTargetHandle("opaque_qqqqqqqqqqqqqqqq"),
    networkRequestDigest: `sha256:${"a".repeat(64)}`
  });
  return {
    attachmentExecutor: async (_file: string, args: string[]) => {
      calls.attachment.push([...args]);
      if (args[2] === "network") return {
        stderr: "",
        stdout: JSON.stringify([{
          Id: bindings.attachment.data_network.id,
          Internal: true,
          Labels: bindings.attachment.data_network.labels,
          Name: bindings.attachment.data_network.name
        }])
      };
      throw new DockerOrganizationAttachmentProviderError("not_found");
    },
    bindings,
    calls,
    drift,
    secretExecutor: async (_file: string, args: string[]) => {
      calls.secret.push([...args]);
      throw new DockerSecretProviderError("not_found");
    },
    worldExecutor: async (_file: string, args: string[]) => {
      calls.world.push([...args]);
      throw new DockerWorldServiceProviderError("not_found");
    }
  };
};

export const cleanupResourceExecutor = (specs: DockerResourceSpec[]) => {
  const present = new Set(specs.map(({ name }) => name));
  const calls: string[][] = [];
  const executor: DockerResourceExecutor = async (_file, args) => {
    calls.push(args);
    const name = args.at(-1)!;
    const spec = specs.find((candidate) => candidate.name === name);
    if (!spec) throw new Error("unknown resource");
    if (args[3] === "inspect") {
      if (!present.has(name)) throw new DockerResourceProviderError("not_found");
      return {
        stderr: "",
        stdout: JSON.stringify([spec.kind === "data_network"
          ? { Internal: true, Labels: spec.labels, Name: name }
          : { Labels: spec.labels, Name: name }])
      };
    }
    if (args[3] === "rm") {
      present.delete(name);
      return { stderr: "", stdout: `${name}\n` };
    }
    throw new Error("unexpected resource command");
  };
  return { calls, executor, present };
};

export const cleanupAuthorityStores = (input: {
  readonly admission?: unknown;
  readonly attachment?: unknown;
  readonly index?: unknown;
  readonly world?: unknown;
} = {}) => {
  const loads = { attachment: 0, world: 0 };
  return {
    attachmentStore: {
      loadAttachment: async () => (loads.attachment += 1, input.attachment)
    } as unknown as OrganizationAttachmentAuthorityStore,
    evidenceExportStore: {
      loadAdmission: async () => input.admission,
      loadIndex: async () => input.index ?? null
    } as unknown as EvidenceExportAuthorityStore,
    loads,
    worldStore: {
      loadService: async () => (loads.world += 1, input.world)
    } as unknown as WorldServiceAuthorityStore
  };
};
