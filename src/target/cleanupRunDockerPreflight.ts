import { SpawnfileError } from "../shared/index.js";
import {
  parseTargetResourceExportIndex,
  type OpaqueTargetHandle,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import { type CleanupRunPlan, type CleanupRunResource } from "./cleanupRun.js";
import {
  type DockerSecretCleanupAuthority
} from "./dockerSecretsLifecycle.js";
import { createExistingDockerSecretSpec } from "./dockerSecretsProvider.js";
import {
  createDockerResourceSpec,
  type DockerResourceSpec
} from "./dockerResourcesProvider.js";
import {
  parseWorldServiceBinding,
  type WorldServiceAuthorityStore,
  type WorldServiceBinding
} from "./dockerWorldServiceStore.js";
import {
  createEvidenceExportHandle,
  evidenceReceiptLabels,
  parseEvidenceVolumeAuthority
} from "./evidenceExportProvider.js";
import { type EvidenceExportAuthorityStore } from "./evidenceExportStore.js";
import {
  parseOrganizationAttachmentBinding,
  type OrganizationAttachmentAuthorityStore,
  type OrganizationAttachmentBinding
} from "./organizationAttachmentStore.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";

const CLEANUP_ERROR = "Target cleanup failed";
type CleanupRequest = Extract<TargetResourceRequest, { operation: "cleanup_run" }>;
type Role = "attachment" | "dataNetwork" | "evidence" | "secrets" | "world";

export interface DockerCleanupRunPreflightOptions {
  readonly attachmentStore: OrganizationAttachmentAuthorityStore;
  readonly evidenceExportStore: EvidenceExportAuthorityStore;
  readonly journal: TargetJournalStore;
  readonly worldStore: WorldServiceAuthorityStore;
}
interface Completed {
  readonly entry: {
    readonly operation: TargetResourceRequest["operation"];
    readonly operation_handle: OpaqueTargetHandle;
    readonly request_digest: TargetJournalClaim["requestDigest"];
  };
  readonly receipt: TargetResourceReceipt;
}

const fail = (): never => {
  throw new SpawnfileError("runtime_error", CLEANUP_ERROR);
};
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const requestDigest = (raw: string): TargetJournalClaim["requestDigest"] => {
  if (!/^sha256:[a-f0-9]{64}$/u.test(raw)) return fail();
  return raw as TargetJournalClaim["requestDigest"];
};
const resource = (
  handle: OpaqueTargetHandle,
  authority: unknown
): CleanupRunResource => Object.freeze({ authority, handle });
const roleFor = (operation: TargetResourceRequest["operation"]): Role | null => {
  switch (operation) {
    case "attach_organization": return "attachment";
    case "create_data_network": return "dataNetwork";
    case "create_evidence_volume": return "evidence";
    case "prepare_secret_bindings": return "secrets";
    case "create_world_service": return "world";
    default: return null;
  }
};

const completedEntries = async (
  request: CleanupRequest,
  options: DockerCleanupRunPreflightOptions
): Promise<Completed[]> => {
  const snapshot = await options.journal.read();
  if (snapshot.run_id !== request.run_id
    || snapshot.descriptor_digest !== request.descriptor_digest
    || !same(snapshot.selected_target, request.selected_target)) return fail();
  const completed: Completed[] = [];
  for (const entry of snapshot.entries) {
    if (entry.state !== "completed") continue;
    const digest = requestDigest(entry.request_digest);
    const resolved = await options.journal.resolveCompletedReceipt({
      operationHandle: entry.operation_handle,
      requestDigest: digest
    });
    if (!resolved) return fail();
    const receipt = resolved.receipt;
    if (receipt.operation !== entry.operation
      || receipt.operation_handle !== entry.operation_handle
      || receipt.request_digest !== entry.request_digest
      || receipt.run_id !== request.run_id
      || receipt.descriptor_digest !== request.descriptor_digest
      || !same(receipt.selected_target, request.selected_target)) return fail();
    completed.push({
      entry: {
        operation: entry.operation,
        operation_handle: entry.operation_handle,
        request_digest: digest
      },
      receipt
    });
  }
  return completed;
};

const exactRoles = (completed: readonly Completed[]): Map<Role, Completed> => {
  const roles = new Map<Role, Completed>();
  for (const item of completed) {
    const role = roleFor(item.entry.operation);
    if (!role) continue;
    if (roles.has(role) || item.receipt.result_handle === null) return fail();
    roles.set(role, item);
  }
  return roles;
};
const requireRole = (
  roles: ReadonlyMap<Role, Completed>,
  role: Role,
  supplied: OpaqueTargetHandle | undefined
): Completed | null => {
  const found = roles.get(role);
  if ((found === undefined) !== (supplied === undefined)) return fail();
  if (!found) return null;
  if (found.receipt.result_handle !== supplied) return fail();
  return found;
};
const specFor = (
  kind: "data_network" | "evidence_volume",
  completed: Completed,
  request: CleanupRequest
): DockerResourceSpec => {
  const spec = createDockerResourceSpec({
    kind,
    operationHandle: completed.entry.operation_handle,
    requestDigest: completed.entry.request_digest,
    runId: request.run_id,
    selectedTargetHandle: request.selected_target.handle
  });
  if (spec.resultHandle !== completed.receipt.result_handle) return fail();
  return spec;
};

const matchingWorld = (
  binding: WorldServiceBinding,
  request: CleanupRequest,
  network: DockerResourceSpec,
  evidence: DockerResourceSpec | null,
  secretAuthority: DockerSecretCleanupAuthority | null
): void => {
  const secretSpec = secretAuthority
    ? createExistingDockerSecretSpec(secretAuthority) : null;
  if (binding.world_service_handle !== request.world_service_handle
    || binding.resolution.authorization.run_id !== request.run_id
    || binding.resolution.authorization.descriptor_digest !== request.descriptor_digest
    || !same(binding.resolution.authorization.selected_target, request.selected_target)
    || binding.resources.data_network.handle !== network.resultHandle
    || binding.resources.data_network.name !== network.name
    || !same(binding.resources.data_network.labels, network.labels)
    || binding.resources.evidence_volume.handle !== evidence?.resultHandle
    || binding.resources.evidence_volume.name !== evidence?.name
    || !same(binding.resources.evidence_volume.labels, evidence?.labels)
    || binding.resources.secret_bindings.handle !== secretSpec?.resultHandle
    || binding.resources.secret_bindings.name !== secretSpec?.volumeName
    || !same(binding.resources.secret_bindings.labels, secretSpec?.labels)) return fail();
};
const matchingAttachment = (
  binding: OrganizationAttachmentBinding,
  request: CleanupRequest,
  network: DockerResourceSpec
): void => {
  if (binding.attachment_handle !== request.organization_attachment_handle
    || binding.resolution.authorization.run_id !== request.run_id
    || binding.resolution.authorization.descriptor_digest !== request.descriptor_digest
    || !same(binding.resolution.authorization.selected_target, request.selected_target)
    || binding.data_network.handle !== network.resultHandle
    || binding.data_network.name !== network.name
    || !same(binding.data_network.labels, network.labels)) return fail();
};

const exportState = async (
  evidence: DockerResourceSpec | null,
  completed: readonly Completed[],
  request: CleanupRequest,
  options: DockerCleanupRunPreflightOptions
): Promise<CleanupRunPlan["exportState"]> => {
  const exports = completed.filter(({ entry }) =>
    entry.operation === "export_evidence_volume");
  if (!evidence) {
    if (exports.length !== 0) return fail();
    return "not_requested";
  }
  if (exports.length === 0) return "incomplete";
  if (exports.length !== 1) return fail();
  const exported = exports[0]!;
  if (exported.receipt.export_state !== "exported"
    || exported.receipt.result_handle === null) return fail();
  const admission = await options.evidenceExportStore.loadAdmission(
    exported.entry.operation_handle
  );
  const evidenceAuthority = parseEvidenceVolumeAuthority(admission.evidence_volume);
  if (admission.operation_handle !== exported.entry.operation_handle
    || admission.request_digest !== exported.entry.request_digest
    || evidenceAuthority.resultHandle !== evidence.resultHandle
    || evidenceAuthority.name !== evidence.name
    || !same(evidenceAuthority.labels, evidence.labels)
    || admission.run_id !== request.run_id
    || admission.descriptor_digest !== request.descriptor_digest
    || !same(admission.selected_target, request.selected_target)) return fail();
  const loaded = await options.evidenceExportStore.loadIndex(admission);
  if (!loaded) return fail();
  const index = parseTargetResourceExportIndex(loaded.index);
  const expectedExportHandle = createEvidenceExportHandle({
    evidenceVolumeHandle: evidence.resultHandle,
    operationHandle: exported.entry.operation_handle,
    requestDigest: exported.entry.request_digest
  });
  if (index.state !== "exported" || index.run_id !== request.run_id
    || index.export_handle !== expectedExportHandle
    || exported.receipt.result_handle !== expectedExportHandle
    || !same(index.labels, evidenceReceiptLabels(evidenceAuthority))
    || !same(exported.receipt.labels, index.labels)) return fail();
  return "exported";
};

export const prepareDockerCleanupRun = async (
  request: CleanupRequest,
  options: DockerCleanupRunPreflightOptions
): Promise<CleanupRunPlan> => {
  const completed = await completedEntries(request, options);
  const roles = exactRoles(completed);
  const networkCompleted = roles.get("dataNetwork");
  const network = networkCompleted
    ? specFor("data_network", networkCompleted, request)
    : null;
  const evidenceCompleted = requireRole(
    roles, "evidence", request.evidence_volume_handle
  );
  const secretCompleted = requireRole(
    roles, "secrets", request.secret_bindings_handle
  );
  const worldCompleted = requireRole(roles, "world", request.world_service_handle);
  const attachmentCompleted = requireRole(
    roles, "attachment", request.organization_attachment_handle
  );
  if (!network && (worldCompleted || attachmentCompleted)) return fail();
  const evidence = evidenceCompleted
    ? specFor("evidence_volume", evidenceCompleted, request) : null;
  const worldBinding = worldCompleted
    ? parseWorldServiceBinding(await options.worldStore.loadService(
      worldCompleted.receipt.result_handle!
    )) : null;
  const attachmentBinding = attachmentCompleted
    ? parseOrganizationAttachmentBinding(await options.attachmentStore.loadAttachment(
      attachmentCompleted.receipt.result_handle!
    )) : null;
  const secretAuthority: DockerSecretCleanupAuthority | null = secretCompleted
    ? Object.freeze({
      bindingsHandle: secretCompleted.receipt.result_handle!,
      runId: request.run_id,
      selectedTargetHandle: request.selected_target.handle
    }) : null;
  if (worldBinding) {
    matchingWorld(worldBinding, request, network!, evidence, secretAuthority);
  }
  if (attachmentBinding) matchingAttachment(attachmentBinding, request, network!);
  if (worldBinding && attachmentBinding
    && (worldBinding.resources.data_network.handle
      !== attachmentBinding.data_network.handle
      || worldBinding.resources.data_network.name
      !== attachmentBinding.data_network.name
      || !same(worldBinding.resources.data_network.labels,
        attachmentBinding.data_network.labels))) return fail();
  const state = await exportState(evidence, completed, request, options);
  if (request.cleanup_policy === "remove" && evidence && state !== "exported") {
    return fail();
  }
  return Object.freeze({
    attachment: attachmentBinding
      ? resource(attachmentBinding.attachment_handle, attachmentBinding) : null,
    cleanupPolicy: request.cleanup_policy,
    dataNetwork: network
      ? resource(network.resultHandle, Object.freeze(network)) : null,
    evidence: evidence ? resource(evidence.resultHandle, Object.freeze(evidence)) : null,
    exportState: state,
    secrets: secretAuthority
      ? resource(secretAuthority.bindingsHandle, secretAuthority) : null,
    world: worldBinding
      ? resource(worldBinding.world_service_handle, worldBinding) : null
  });
};
