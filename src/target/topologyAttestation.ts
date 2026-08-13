import { boundedRedactedText, SpawnfileError } from "../shared/index.js";
import { types as nodeTypes } from "node:util";
import {
  parseTargetTopologyAttestationRequest,
  type TargetResourceReceipt,
  type TargetTopologyAttestationRequest,
  type TargetTopologyReceipt
} from "./contracts.js";
import {
  type DockerResourceExecutor
} from "./dockerResourcesProvider.js";
import { createDockerContextSnapshot, type DockerContextSnapshot } from "./dockerContextSnapshot.js";
import {
  ORGANIZATION_NETWORK_INSPECTION_FORMAT,
  ORGANIZATION_EGRESS_NETWORK_INSPECTION_FORMAT,
  executeDockerOrganizationAttachment,
  isExpectedOrganizationEgressNetwork,
  organizationTopologyInspectionFormat,
  parseExpectedOrganizationNetwork,
  parseExpectedOrganizationEgressNetwork,
  createDockerOrganizationAttachmentSpec,
  type DockerOrganizationAttachmentExecutor
} from "./organizationAttachmentProvider.js";
import type {
  OrganizationAttachmentAuthorityStore,
  OrganizationAttachmentBinding
} from "./organizationAttachmentStore.js";
import {
  executeDockerWorldService,
  parseExpectedDockerWorldService,
  type DockerWorldServiceExecutor
} from "./dockerWorldServiceProvider.js";
import {
  type WorldServiceAuthorityStore,
  type WorldServiceBinding
} from "./dockerWorldServiceStore.js";
import { worldServiceSpecForBinding } from "./dockerWorldServiceLifecycle.js";
import {
  createCanonicalTargetTopologyReceiptBytes,
  createTargetTopologyAttestationRequestDigest,
  createTargetTopologyReceiptDigest
} from "./handles.js";
import type { TargetDigest } from "./handles.js";
import type { TargetJournalClaim, TargetJournalStore } from "./journal.js";
import {
  activateDockerWorldService,
  type TargetTopologyActivationResult
} from "./topologyActivation.js";
import type { TopologyAttestationReason } from "./topologyAttestationErrors.js";

export const TARGET_TOPOLOGY_ATTESTATION_ERROR = "Target topology attestation failed";

export interface TargetTopologyAttestationResult {
  readonly receipt: TargetTopologyReceipt;
  readonly receiptBytes: string;
}

export interface TargetTopologyAttestor {
  activate(raw: unknown): Promise<TargetTopologyActivationResult>;
  attest(raw: unknown): Promise<TargetTopologyAttestationResult>;
}

export interface CreateTargetTopologyAttestorOptions {
  readonly attachmentExecutor: DockerOrganizationAttachmentExecutor;
  readonly attachmentStore: OrganizationAttachmentAuthorityStore;
  readonly context: string;
  readonly resolveJournal: (input: {
    readonly descriptorDigest: unknown;
    readonly runId: unknown;
    readonly selectedTarget: unknown;
  }) => Promise<TargetJournalStore>;
  readonly resourceExecutor: DockerResourceExecutor;
  readonly timeoutMs: number;
  readonly worldExecutor: DockerWorldServiceExecutor;
  readonly worldStore: WorldServiceAuthorityStore;
}

const fail = (reason: TopologyAttestationReason): never => {
  throw new SpawnfileError("runtime_error", `${TARGET_TOPOLOGY_ATTESTATION_ERROR}: ${reason}`);
};
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const context = (raw: unknown): string =>
  typeof raw === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(raw) ? raw : fail("invalid_context");
const timeout = (raw: unknown): number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= 120_000 ? raw : fail("invalid_timeout");

type CompletedTuple = TargetTopologyAttestationRequest["data_network"];

const claim = (tuple: CompletedTuple): TargetJournalClaim => ({
  operationHandle: tuple.operation_handle,
  requestDigest: tuple.request_digest as TargetDigest
});

const completed = async (
  journal: TargetJournalStore,
  request: TargetTopologyAttestationRequest,
  tuple: CompletedTuple,
  operation: TargetResourceReceipt["operation"]
): Promise<TargetResourceReceipt> => {
  const result = await journal.resolveCompletedReceipt(claim(tuple));
  if (!result) return fail("journal_receipt_missing");
  const receipt = result.receipt;
  if (receipt.operation !== operation) return fail("receipt_operation_mismatch");
  if (receipt.operation_handle !== tuple.operation_handle) return fail("receipt_operation_handle_mismatch");
  if (receipt.request_digest !== tuple.request_digest) return fail("receipt_request_digest_mismatch");
  if (receipt.result_handle !== tuple.result_handle) return fail("receipt_result_handle_mismatch");
  if (receipt.run_id !== request.run_id) return fail("run_id_mismatch");
  if (receipt.descriptor_digest !== request.descriptor_digest) return fail("descriptor_digest_mismatch");
  if (!same(receipt.selected_target, request.selected_target)) return fail("selected_target_mismatch");
  return receipt;
};

const sameTarget = (left: unknown, right: TargetTopologyAttestationRequest["selected_target"]): boolean =>
  same(left, { fingerprint: right.fingerprint, handle: right.handle });

const attachmentSpec = (
  binding: OrganizationAttachmentBinding
) => createDockerOrganizationAttachmentSpec({
  containerId: binding.resolution.network_attachment.container_id,
  dataNetworkOperationHandle: binding.data_network.operation_handle,
  dataNetworkRequestDigest: binding.data_network.request_digest,
  deploymentLabels: binding.resolution.network_attachment.deployment_labels,
  operationHandle: binding.resolution.authorization.operation_handle,
  organizationHandoffHandle: binding.resolution.authorization.organization_handoff_handle,
  requestDigest: binding.resolution.authorization.request_digest,
  runId: binding.resolution.authorization.run_id,
  selectedTargetHandle: binding.resolution.authorization.selected_target.handle
});

const validateAttachment = (
  binding: OrganizationAttachmentBinding,
  request: TargetTopologyAttestationRequest
): void => {
  const tuple = request.organization_attachment;
  if (binding.attachment_handle !== tuple.result_handle
    || binding.data_network.handle !== request.data_network.result_handle
    || binding.data_network.operation_handle !== request.data_network.operation_handle
    || binding.data_network.request_digest !== request.data_network.request_digest
    || binding.resolution.authorization.operation_handle !== tuple.operation_handle
    || binding.resolution.authorization.request_digest !== tuple.request_digest
    || binding.resolution.authorization.run_id !== request.run_id
    || binding.resolution.authorization.descriptor_digest !== request.descriptor_digest
    || !sameTarget(binding.resolution.authorization.selected_target, request.selected_target)) fail("attachment_binding_mismatch");
};

const validateWorldService = (
  binding: WorldServiceBinding,
  request: TargetTopologyAttestationRequest
): void => {
  const create = request.world_service.create;
  if (binding.world_service_handle !== create.result_handle
    || binding.resolution.authorization.operation_handle !== create.operation_handle
    || binding.resolution.authorization.request_digest !== create.request_digest
    || binding.resolution.authorization.data_network_handle !== request.data_network.result_handle
    || binding.resources.data_network.handle !== request.data_network.result_handle
    || binding.resolution.authorization.run_id !== request.run_id
    || binding.resolution.authorization.descriptor_digest !== request.descriptor_digest
    || !sameTarget(binding.resolution.authorization.selected_target, request.selected_target)) fail("world_service_binding_mismatch");
};

const bindSelectedTarget = async (
  value: TargetTopologyAttestationRequest,
  options: Readonly<CreateTargetTopologyAttestorOptions>
): Promise<DockerContextSnapshot> => {
  return createDockerContextSnapshot({
    context: options.context,
    executor: options.resourceExecutor,
    selectedTarget: value.selected_target,
    timeoutMs: options.timeoutMs
  });
};

const inspectBound = async (
  request: TargetTopologyAttestationRequest,
  binding: OrganizationAttachmentBinding,
  world: WorldServiceBinding,
  target: readonly string[],
  options: Readonly<CreateTargetTopologyAttestorOptions>
): Promise<void> => {
  const organization = attachmentSpec(binding);
  if (organization.resultHandle !== binding.attachment_handle
    || organization.network.resultHandle !== request.data_network.result_handle
    || organization.network.name !== binding.data_network.name
    || !same(organization.network.labels, binding.data_network.labels)) return fail("attachment_binding_mismatch");
  const inspectedNetworkId = await (async () => {
    const networkInspection = await executeDockerOrganizationAttachment({
      args: [...target, "network", "inspect", "--format",
        ORGANIZATION_NETWORK_INSPECTION_FORMAT, organization.network.name],
      executor: options.attachmentExecutor,
      timeoutMs: options.timeoutMs
    });
    return networkInspection.stderr === ""
      ? parseExpectedOrganizationNetwork(networkInspection.stdout, organization) : null;
  })();
  if (inspectedNetworkId === null || inspectedNetworkId !== binding.data_network.id) return fail("data_network_inspection_mismatch");
  const egressNetwork = await (async () => {
    const organizationInspection = await executeDockerOrganizationAttachment({
      args: [...target, "container", "inspect", "--format",
        organizationTopologyInspectionFormat(organization.network.name), organization.containerId],
      executor: options.attachmentExecutor,
      timeoutMs: options.timeoutMs
    });
    return organizationInspection.stderr === ""
      ? parseExpectedOrganizationEgressNetwork(organizationInspection.stdout, organization) : null;
  })();
  if (egressNetwork === null) return fail("organization_egress_missing");
  if (egressNetwork.dataNetworkId !== binding.data_network.id) return fail("organization_egress_data_network_mismatch");
  const expectedEgress = await (async () => {
    const egressInspection = await executeDockerOrganizationAttachment({
      args: [...target, "network", "inspect", "--format",
        ORGANIZATION_EGRESS_NETWORK_INSPECTION_FORMAT, egressNetwork.name],
      executor: options.attachmentExecutor,
      timeoutMs: options.timeoutMs
    });
    return egressInspection.stderr === ""
      && isExpectedOrganizationEgressNetwork(egressInspection.stdout, egressNetwork);
  })();
  if (!expectedEgress) return fail("organization_egress_policy_mismatch");
  const egressAfter = await (async () => {
    const organizationInspection = await executeDockerOrganizationAttachment({
      args: [...target, "container", "inspect", "--format",
        organizationTopologyInspectionFormat(organization.network.name), organization.containerId],
      executor: options.attachmentExecutor,
      timeoutMs: options.timeoutMs
    });
    return organizationInspection.stderr === ""
      ? parseExpectedOrganizationEgressNetwork(organizationInspection.stdout, organization) : null;
  })();
  if (!egressAfter || egressAfter.id !== egressNetwork.id || egressAfter.name !== egressNetwork.name
    || egressAfter.dataNetworkId !== binding.data_network.id) return fail("organization_topology_changed");

  const worldSpec = worldServiceSpecForBinding(world);
  if (worldSpec.resultHandle !== world.world_service_handle) return fail("world_service_handle_mismatch");
  const worldInspection = await executeDockerWorldService({
    args: [...target, "container", "inspect", "--format",
      worldSpec.inspectionFormat, world.container_id],
    executor: options.worldExecutor,
    timeoutMs: options.timeoutMs
  });
  if (worldInspection.stderr !== "") {
    return fail(`world_service_inspection_stderr:${boundedRedactedText(worldInspection.stderr)}`);
  }
  let parsedWorld: ReturnType<typeof parseExpectedDockerWorldService>;
  try {
    parsedWorld = parseExpectedDockerWorldService(worldInspection.stdout, worldSpec);
  } catch {
    parsedWorld = null;
  }
  if (!parsedWorld) return fail("world_service_inspection_unparseable");
  if (parsedWorld.status !== "running") return fail("world_service_status_mismatch");
  if (parsedWorld.containerId !== world.container_id) return fail("world_service_container_id_mismatch");
  if (parsedWorld.networkId !== binding.data_network.id) return fail("world_service_network_id_mismatch");
  const finalNetworkInspection = await executeDockerOrganizationAttachment({
    args: [...target, "network", "inspect", "--format",
      ORGANIZATION_NETWORK_INSPECTION_FORMAT, organization.network.name],
    executor: options.attachmentExecutor,
    timeoutMs: options.timeoutMs
  });
  if (finalNetworkInspection.stderr !== ""
    || parseExpectedOrganizationNetwork(finalNetworkInspection.stdout, organization) !== binding.data_network.id) return fail("final_data_network_mismatch");
};

const inspect = async <Result = void>(
  request: TargetTopologyAttestationRequest,
  binding: OrganizationAttachmentBinding,
  world: WorldServiceBinding,
  options: Readonly<CreateTargetTopologyAttestorOptions>,
  afterProof?: (target: readonly string[]) => Promise<Result>
): Promise<Result | void> => {
  const snapshot = await bindSelectedTarget(request, options);
  try {
    await inspectBound(request, binding, world, snapshot.args, options);
    return await afterProof?.(snapshot.args);
  } finally {
    await snapshot.dispose();
  }
};

const receiptFor = (request: TargetTopologyAttestationRequest): TargetTopologyAttestationResult => {
  const body = {
    descriptor_digest: request.descriptor_digest,
    handoff_scope: "organization_to_private_service" as const,
    organization: { data_network_attachment: "exact" as const, egress_policy: "egress_only" as const },
    receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: createTargetTopologyAttestationRequestDigest(request),
    run_id: request.run_id,
    selected_target: request.selected_target,
    service_discovery: "dns_only" as const,
    version: "spawnfile.target-topology-receipt.v1" as const,
    world_network: "private_internal" as const,
    world_service: {
      data_network_attachment: "exactly_one" as const,
      egress_policy: "none" as const,
      published_ports: "none" as const
    }
  };
  const receipt = {
    ...body,
    receipt_digest: createTargetTopologyReceiptDigest(body)
  };
  const bytes = createCanonicalTargetTopologyReceiptBytes(receipt);
  return Object.freeze({ receipt, receiptBytes: bytes });
};

/**
 * Builds the read-only owner endpoint.  The only caller-controlled input is a
 * public correlation packet; all topology facts come from exact completed
 * journal records, private capability stores and bounded Docker projections.
 */
export const createTargetTopologyAttestor = (
  raw: CreateTargetTopologyAttestorOptions
): TargetTopologyAttestor => {
  const names = [
    "attachmentExecutor", "attachmentStore", "context", "resolveJournal",
    "resourceExecutor", "timeoutMs", "worldExecutor", "worldStore"
  ] as const;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeTypes.isProxy(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return fail("invalid_attestor_options");
  const keys = Reflect.ownKeys(raw);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key as typeof names[number]))
    || names.some((key) => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return fail("invalid_attestor_shape");
  const value = Object.fromEntries(names.map((name) => [name, descriptors[name]!.value])) as unknown as CreateTargetTopologyAttestorOptions;
  if (typeof value.resolveJournal !== "function" || typeof value.resourceExecutor !== "function"
    || typeof value.attachmentExecutor !== "function" || typeof value.worldExecutor !== "function"
    || !value.attachmentStore || typeof value.attachmentStore.loadAttachment !== "function"
    || !value.worldStore || typeof value.worldStore.loadService !== "function") return fail("invalid_attestor_dependencies");
  const options = Object.freeze({ ...value, context: context(value.context), timeoutMs: timeout(value.timeoutMs) });
  const prove = async <Result>(
    rawRequest: unknown,
    afterProof: (
      request: TargetTopologyAttestationRequest,
      topology: TargetTopologyAttestationResult,
      world: WorldServiceBinding,
      target: readonly string[]
    ) => Promise<Result>
  ): Promise<Result> => {
    const request = parseTargetTopologyAttestationRequest(rawRequest);
    const journal = await options.resolveJournal({
      descriptorDigest: request.descriptor_digest,
      runId: request.run_id,
      selectedTarget: request.selected_target
    });
    return journal.withLifecycleLease(async () => {
      await Promise.all([
        completed(journal, request, request.data_network, "create_data_network"),
        completed(journal, request, request.organization_attachment, "attach_organization"),
        completed(journal, request, request.world_service.create, "create_world_service"),
        completed(journal, request, request.world_service.start, "start_world_service")
      ]);
      const [attachment, world] = await Promise.all([
        options.attachmentStore.loadAttachment(request.organization_attachment.result_handle),
        options.worldStore.loadService(request.world_service.create.result_handle)
      ]);
      validateAttachment(attachment, request);
      validateWorldService(world, request);
      const topology = receiptFor(request);
      const result = await inspect(
        request,
        attachment,
        world,
        options,
        (target) => afterProof(request, topology, world, target)
      );
      if (result === undefined) return fail("attestation_result_missing");
      return result;
    });
  };
  return Object.freeze({
    activate: async (rawRequest: unknown): Promise<TargetTopologyActivationResult> => {
      try {
        return await prove(rawRequest, async (_request, topology, world, target) =>
          activateDockerWorldService({
            executor: options.worldExecutor,
            target,
            timeoutMs: options.timeoutMs,
            topology: topology.receipt,
            world
          }));
      } catch (error) {
        if (error instanceof SpawnfileError
          && error.message.startsWith(TARGET_TOPOLOGY_ATTESTATION_ERROR)) throw error;
        return fail("activation_failed");
      }
    },
    attest: async (rawRequest: unknown): Promise<TargetTopologyAttestationResult> => {
      try {
        return await prove(rawRequest, async (_request, topology) => topology);
      } catch (error) {
        if (error instanceof SpawnfileError
          && error.message.startsWith(TARGET_TOPOLOGY_ATTESTATION_ERROR)) throw error;
        return fail("attestation_failed");
      }
    }
  });
};
