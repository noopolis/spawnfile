import { SpawnfileError } from "../shared/index.js";
import {
  parseTargetResourceRequest,
  type OpaqueTargetHandle,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { createTargetReceiptDigest } from "./handles.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";
import {
  createOrganizationAttachmentAuthorization,
  parseOrganizationAttachmentResolution,
  type OrganizationAttachmentResolution,
  type OrganizationAttachmentResolver
} from "./organizationAttachmentAuthority.js";
import {
  ORGANIZATION_ATTACHMENT_ERROR,
  createDockerOrganizationAttachmentSpec,
  type DockerOrganizationAttachmentExecutor
} from "./organizationAttachmentProvider.js";
import {
  executeOrganizationAttachmentCommand,
  inspectContainer,
  inspectNetwork,
  mutate
} from "./organizationAttachmentLifecycle.js";
import {
  createOrganizationAttachmentBinding,
  createOrganizationAttachmentMutationAdmission,
  type OrganizationAttachmentAuthorityStore,
  type OrganizationAttachmentBinding
} from "./organizationAttachmentStore.js";

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
type AttachRequest = Extract<TargetResourceRequest, { operation: "attach_organization" }>;
type DetachRequest = Extract<TargetResourceRequest, { operation: "detach_organization" }>;
type AttachmentRequest = AttachRequest | DetachRequest;
type OperationResult = {
  readonly receipt: TargetResourceReceipt;
  readonly receiptBytes: string;
};

export interface DockerOrganizationAttachmentOperationsOptions {
  readonly authorityStore: OrganizationAttachmentAuthorityStore;
  readonly context: unknown;
  readonly executor: DockerOrganizationAttachmentExecutor;
  readonly journal: TargetJournalStore;
  readonly resolver: OrganizationAttachmentResolver;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: unknown;
}

export interface DockerOrganizationAttachmentOperations {
  execute(raw: unknown): Promise<OperationResult>;
}

interface ValidOptions {
  readonly authorityStore: OrganizationAttachmentAuthorityStore;
  readonly context: string;
  readonly executor: DockerOrganizationAttachmentExecutor;
  readonly journal: TargetJournalStore;
  readonly resolver: OrganizationAttachmentResolver;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

interface DataNetworkClaim {
  readonly operationHandle: OpaqueTargetHandle;
  readonly requestDigest: string;
}

const fail = (): never => {
  throw new SpawnfileError("runtime_error", ORGANIZATION_ATTACHMENT_ERROR);
};
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const validOptions = (
  raw: DockerOrganizationAttachmentOperationsOptions
): ValidOptions => {
  if (!raw.authorityStore
    || typeof raw.authorityStore.bindAttachment !== "function"
    || typeof raw.authorityStore.bindMutationAdmission !== "function"
    || typeof raw.authorityStore.bindResolution !== "function"
    || typeof raw.authorityStore.loadAttachment !== "function"
    || typeof raw.authorityStore.requireMutationAdmission !== "function"
    || typeof raw.context !== "string" || !CONTEXT_PATTERN.test(raw.context)
    || typeof raw.executor !== "function" || !raw.journal
    || !raw.resolver || typeof raw.resolver.resolve !== "function"
    || raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== "number"
      || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1
      || raw.timeoutMs > 120_000)) return fail();
  return {
    authorityStore: raw.authorityStore,
    context: raw.context,
    executor: raw.executor,
    journal: raw.journal,
    resolver: raw.resolver,
    signal: raw.signal,
    timeoutMs: raw.timeoutMs ?? 10_000
  };
};

const parseRequest = (raw: unknown): AttachmentRequest => {
  const request = parseTargetResourceRequest(raw);
  if (request.operation !== "attach_organization"
    && request.operation !== "detach_organization") return fail();
  return request as AttachmentRequest;
};

const selectedContextMatches = async (
  request: AttachmentRequest,
  options: ValidOptions
): Promise<void> => {
  const selected = await selectTarget({
    context: options.context,
    dockerCommand: "docker",
    execFile: async (_file, args, execution) => executeOrganizationAttachmentCommand(args, {
      ...options,
      signal: execution.signal,
      timeoutMs: execution.timeout
    }),
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  if (!same({ fingerprint: selected.fingerprint, handle: selected.handle },
    request.selected_target)) return fail();
};

const dataNetworkClaim = async (
  request: AttachmentRequest,
  options: ValidOptions
): Promise<DataNetworkClaim> => {
  const journal = await options.journal.read();
  const matches = journal.entries
    .filter((entry) => entry.operation === "create_data_network" && entry.state === "completed")
    .filter((entry) => createDockerResourceSpec({
      kind: "data_network",
      operationHandle: entry.operation_handle,
      requestDigest: entry.request_digest,
      runId: request.run_id,
      selectedTargetHandle: request.selected_target.handle
    }).resultHandle === request.data_network_handle);
  if (matches.length !== 1) return fail();
  return {
    operationHandle: matches[0]!.operation_handle,
    requestDigest: matches[0]!.request_digest
  };
};

const resolveAttach = async (
  request: AttachRequest,
  claim: TargetJournalClaim,
  options: ValidOptions
): Promise<OrganizationAttachmentResolution> => {
  const authorization = createOrganizationAttachmentAuthorization({
    descriptorDigest: request.descriptor_digest,
    operationHandle: claim.operationHandle,
    organizationHandoffHandle: request.organization_handoff_handle,
    requestDigest: claim.requestDigest,
    runId: request.run_id,
    selectedTarget: request.selected_target
  });
  const resolution = parseOrganizationAttachmentResolution(
    await options.resolver.resolve({ authorization, signal: options.signal })
  );
  if (!same(resolution.authorization, authorization)) return fail();
  await options.authorityStore.bindResolution(resolution);
  return resolution;
};

const receiptFor = (input: {
  readonly claim: TargetJournalClaim;
  readonly labels: Readonly<Record<string, string>>;
  readonly request: AttachmentRequest;
  readonly resultHandle: OpaqueTargetHandle | null;
}): TargetResourceReceipt => {
  const raw = {
    cleanup_state: "not_requested",
    descriptor_digest: input.request.descriptor_digest,
    export_state: "not_requested",
    labels: Object.entries(input.labels).map(([key, value]) => ({ key, value })),
    operation: input.request.operation,
    operation_handle: input.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: input.claim.requestDigest,
    result_handle: input.resultHandle,
    resulting_revision: input.request.expected_revision + 1,
    run_id: input.request.run_id,
    selected_target: input.request.selected_target,
    version: "spawnfile.target-resource.receipt.v1"
  };
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) } as TargetResourceReceipt;
};

class DockerOrganizationAttachmentOperationsImpl
implements DockerOrganizationAttachmentOperations {
  readonly #live = new Map<string, {
    readonly promise: Promise<OperationResult>;
    readonly request: AttachmentRequest;
  }>();
  readonly #options: ValidOptions;
  public constructor(options: ValidOptions) { this.#options = options; }

  public execute(raw: unknown): Promise<OperationResult> {
    let request: AttachmentRequest;
    try { request = parseRequest(raw); }
    catch { return Promise.reject(new SpawnfileError("runtime_error", ORGANIZATION_ATTACHMENT_ERROR)); }
    const active = this.#live.get(request.idempotency_key);
    if (active) return same(active.request, request)
      ? active.promise
      : Promise.reject(new SpawnfileError("runtime_error", ORGANIZATION_ATTACHMENT_ERROR));
    const promise = this.executeOwner(request);
    this.#live.set(request.idempotency_key, { promise, request });
    void promise.finally(() => {
      if (this.#live.get(request.idempotency_key)?.promise === promise) {
        this.#live.delete(request.idempotency_key);
      }
    }).catch(() => undefined);
    return promise;
  }

  private async executeOwner(request: AttachmentRequest): Promise<OperationResult> {
    try {
      const reservation = await this.#options.journal.reserve(request);
      if (reservation.kind === "replay") {
        return { receipt: reservation.receipt, receiptBytes: reservation.receiptBytes };
      }
      if (request.operation === "attach_organization") {
        return await this.attach(request, reservation.kind, reservation.claim);
      }
      return await this.detach(request, reservation.kind, reservation.claim);
    } catch { return fail(); }
  }

  private async attach(
    request: AttachRequest,
    reservation: "owner" | "pending",
    claim: TargetJournalClaim
  ): Promise<OperationResult> {
    const networkClaim = await dataNetworkClaim(request, this.#options);
    const resolution = await resolveAttach(request, claim, this.#options);
    await selectedContextMatches(request, this.#options);
    const spec = createDockerOrganizationAttachmentSpec({
      containerId: resolution.network_attachment.container_id,
      dataNetworkOperationHandle: networkClaim.operationHandle,
      dataNetworkRequestDigest: networkClaim.requestDigest,
      deploymentLabels: resolution.network_attachment.deployment_labels,
      operationHandle: claim.operationHandle,
      organizationHandoffHandle: request.organization_handoff_handle,
      requestDigest: claim.requestDigest,
      runId: request.run_id,
      selectedTargetHandle: request.selected_target.handle
    });
    if (spec.network.resultHandle !== request.data_network_handle) return fail();
    const networkId = await inspectNetwork(spec, this.#options);
    const binding = createOrganizationAttachmentBinding({
      dataNetworkOperationHandle: networkClaim.operationHandle,
      dataNetworkRequestDigest: networkClaim.requestDigest,
      networkId,
      resolution,
      spec
    });
    await this.#options.authorityStore.bindAttachment(binding);
    const admission = createOrganizationAttachmentMutationAdmission({
      binding, operation: request.operation,
      operationHandle: claim.operationHandle, requestDigest: claim.requestDigest
    });
    if (reservation === "pending") await this.#options.authorityStore
      .requireMutationAdmission(admission);
    const before = await inspectContainer(spec, this.#options);
    if (reservation === "owner" && before.attached) return fail();
    if (reservation === "owner") await this.#options.authorityStore
      .bindMutationAdmission(admission);
    if (!before.attached) {
      await mutate("connect", binding.data_network.id, spec.containerId, this.#options);
    }
    if (!(await inspectContainer(spec, this.#options)).attached) return fail();
    if (await inspectNetwork(spec, this.#options) !== binding.data_network.id) return fail();
    const receipt = receiptFor({
      claim,
      labels: binding.receipt_labels,
      request,
      resultHandle: binding.attachment_handle
    });
    return await this.#options.journal.complete(claim, receipt);
  }

  private async detach(
    request: DetachRequest,
    reservation: "owner" | "pending",
    claim: TargetJournalClaim
  ): Promise<OperationResult> {
    const binding = await this.#options.authorityStore.loadAttachment(
      request.organization_attachment_handle
    );
    if (binding.attachment_handle !== request.organization_attachment_handle
      || binding.data_network.handle !== request.data_network_handle
      || binding.resolution.authorization.run_id !== request.run_id
      || binding.resolution.authorization.descriptor_digest !== request.descriptor_digest
      || !same(binding.resolution.authorization.selected_target, request.selected_target)) return fail();
    const networkClaim = await dataNetworkClaim(request, this.#options);
    if (networkClaim.operationHandle !== binding.data_network.operation_handle
      || networkClaim.requestDigest !== binding.data_network.request_digest) return fail();
    await selectedContextMatches(request, this.#options);
    const spec = createDockerOrganizationAttachmentSpec({
      containerId: binding.resolution.network_attachment.container_id,
      dataNetworkOperationHandle: networkClaim.operationHandle,
      dataNetworkRequestDigest: networkClaim.requestDigest,
      deploymentLabels: binding.resolution.network_attachment.deployment_labels,
      operationHandle: binding.resolution.authorization.operation_handle,
      organizationHandoffHandle:
        binding.resolution.authorization.organization_handoff_handle,
      requestDigest: binding.resolution.authorization.request_digest,
      runId: binding.resolution.authorization.run_id,
      selectedTargetHandle: binding.resolution.authorization.selected_target.handle
    });
    if (spec.resultHandle !== binding.attachment_handle
      || await inspectNetwork(spec, this.#options) !== binding.data_network.id) return fail();
    const admission = createOrganizationAttachmentMutationAdmission({
      binding, operation: request.operation,
      operationHandle: claim.operationHandle, requestDigest: claim.requestDigest
    });
    if (reservation === "pending") await this.#options.authorityStore
      .requireMutationAdmission(admission);
    const before = await inspectContainer(spec, this.#options);
    if (reservation === "owner" && !before.attached) return fail();
    if (reservation === "owner") await this.#options.authorityStore
      .bindMutationAdmission(admission);
    if (before.attached) {
      await mutate("disconnect", binding.data_network.id, spec.containerId, this.#options);
    }
    if ((await inspectContainer(spec, this.#options)).attached) return fail();
    if (await inspectNetwork(spec, this.#options) !== binding.data_network.id) return fail();
    const receipt = receiptFor({
      claim,
      labels: binding.receipt_labels,
      request,
      resultHandle: null
    });
    return await this.#options.journal.complete(claim, receipt);
  }
}

export const createDockerOrganizationAttachmentOperations = (
  options: DockerOrganizationAttachmentOperationsOptions
): DockerOrganizationAttachmentOperations =>
  new DockerOrganizationAttachmentOperationsImpl(validOptions(options));
