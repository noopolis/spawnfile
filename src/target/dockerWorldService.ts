import { SpawnfileError } from "../shared/index.js";
import {
  parseTargetResourceRequest,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";
import {
  WORLD_SERVICE_ERROR,
  type WorldServiceResolver
} from "./dockerWorldServiceAuthority.js";
import {
  DockerWorldServiceProviderError,
  type DockerWorldServiceExecutor,
  type DockerWorldServiceInspection
} from "./dockerWorldServiceProvider.js";
import {
  createWorldServiceReceipt,
  inspectDockerWorldService,
  mutateDockerWorldService,
  resolveWorldServiceCreate,
  sameWorldServiceValue,
  selectedWorldServiceContextMatches,
  verifyWorldServiceResources,
  worldServiceSpecForBinding,
  type WorldServiceLifecycleContext
} from "./dockerWorldServiceLifecycle.js";
import {
  createWorldServiceBinding,
  createWorldServiceMutationAdmission,
  type WorldServiceAuthorityStore
} from "./dockerWorldServiceStore.js";

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const exactMutationAck = (stdout: string, containerId: string): boolean =>
  stdout === "" || stdout === `${containerId}\n`;
type ServiceRequest = Extract<TargetResourceRequest, {
  operation: "create_world_service" | "start_world_service" | "stop_world_service";
}>;
type CreateRequest = Extract<ServiceRequest, { operation: "create_world_service" }>;
type ExistingRequest = Exclude<ServiceRequest, CreateRequest>;
type OperationResult = {
  readonly receipt: TargetResourceReceipt;
  readonly receiptBytes: string;
};

export interface DockerWorldServiceOperationsOptions {
  readonly authorityStore: WorldServiceAuthorityStore;
  readonly context: unknown;
  readonly executor: DockerWorldServiceExecutor;
  readonly journal: TargetJournalStore;
  readonly resolver: WorldServiceResolver;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: unknown;
}

export interface DockerWorldServiceOperations {
  execute(raw: unknown): Promise<OperationResult>;
}

type ValidOptions = WorldServiceLifecycleContext;

const fail = (): never => {
  throw new SpawnfileError("runtime_error", WORLD_SERVICE_ERROR);
};
const validOptions = (raw: DockerWorldServiceOperationsOptions): ValidOptions => {
  if (typeof raw.context !== "string" || !CONTEXT_PATTERN.test(raw.context)
    || typeof raw.executor !== "function"
    || !raw.journal || typeof raw.journal.reserve !== "function"
    || !raw.resolver || typeof raw.resolver.resolve !== "function"
    || !raw.authorityStore || typeof raw.authorityStore.bindResolution !== "function"
    || typeof raw.timeoutMs !== "undefined"
      && (typeof raw.timeoutMs !== "number" || !Number.isSafeInteger(raw.timeoutMs)
        || raw.timeoutMs < 1 || raw.timeoutMs > 120_000)) return fail();
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
const parseRequest = (raw: unknown): ServiceRequest => {
  const request = parseTargetResourceRequest(raw);
  if (request.operation !== "create_world_service"
    && request.operation !== "start_world_service"
    && request.operation !== "stop_world_service") return fail();
  return request;
};

class DockerWorldServiceOperationsImpl implements DockerWorldServiceOperations {
  readonly #live = new Map<string, {
    readonly promise: Promise<OperationResult>;
    readonly request: ServiceRequest;
  }>();
  readonly #options: ValidOptions;
  public constructor(options: ValidOptions) { this.#options = options; }

  public execute(raw: unknown): Promise<OperationResult> {
    let request: ServiceRequest;
    try { request = parseRequest(raw); }
    catch { return Promise.reject(new SpawnfileError("runtime_error", WORLD_SERVICE_ERROR)); }
    const active = this.#live.get(request.idempotency_key);
    if (active) return sameWorldServiceValue(active.request, request) ? active.promise
      : Promise.reject(new SpawnfileError("runtime_error", WORLD_SERVICE_ERROR));
    const promise = this.executeOwner(request).finally(() => {
      if (this.#live.get(request.idempotency_key)?.promise === promise) {
        this.#live.delete(request.idempotency_key);
      }
    });
    this.#live.set(request.idempotency_key, { promise, request });
    return promise;
  }

  private async executeOwner(request: ServiceRequest): Promise<OperationResult> {
    try {
      const reservation = await this.#options.journal.reserve(request);
      if (reservation.kind === "replay") {
        return { receipt: reservation.receipt, receiptBytes: reservation.receiptBytes };
      }
      return request.operation === "create_world_service"
        ? await this.create(request, reservation.claim, reservation.kind)
        : await this.change(request, reservation.claim, reservation.kind);
    } catch { return fail(); }
  }

  private async create(request: CreateRequest, claim: TargetJournalClaim,
    reservation: "owner" | "pending"): Promise<OperationResult> {
    const resolved = await resolveWorldServiceCreate(request, claim, this.#options);
    await selectedWorldServiceContextMatches(request, this.#options);
    await verifyWorldServiceResources(resolved, this.#options);
    const spec = worldServiceSpecForBinding(resolved);
    const admission = createWorldServiceMutationAdmission({
      containerId: null,
      containerName: spec.containerName,
      operation: request.operation,
      operationHandle: claim.operationHandle,
      requestDigest: claim.requestDigest,
      worldServiceHandle: spec.resultHandle
    });
    let current: DockerWorldServiceInspection | null;
    if (reservation === "owner") {
      current = await inspectDockerWorldService(spec.containerName, spec, this.#options);
      if (current !== null) return fail();
      await this.#options.authorityStore.bindMutationAdmission(admission);
    } else {
      await this.#options.authorityStore.requireMutationAdmission(admission);
      current = await inspectDockerWorldService(spec.containerName, spec, this.#options);
    }
    let createdId: string | null = null;
    if (current === null) {
      try {
        const stdout = await mutateDockerWorldService([...spec.createArgs], this.#options);
        const candidate = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
        if (!CONTAINER_ID_PATTERN.test(candidate)) return fail();
        createdId = candidate;
      } catch (error) {
        if (!(error instanceof DockerWorldServiceProviderError)
          || error.kind !== "collision") throw error;
      }
      current = await inspectDockerWorldService(spec.containerName, spec, this.#options);
    }
    if (!current || current.status !== "created"
      || createdId !== null && current.containerId !== createdId) return fail();
    const binding = createWorldServiceBinding({
      containerId: current.containerId,
      dataNetwork: resolved.resources.data_network,
      evidenceVolume: resolved.resources.evidence_volume,
      resolution: resolved.resolution,
      secretBindings: resolved.resources.secret_bindings,
      spec
    });
    await this.#options.authorityStore.bindService(binding);
    const receipt = await createWorldServiceReceipt({ claim, journal: this.#options.journal,
      labels: spec.receiptLabels, request, resultHandle: spec.resultHandle });
    return this.#options.journal.complete(claim, receipt);
  }

  private async change(request: ExistingRequest, claim: TargetJournalClaim,
    reservation: "owner" | "pending"): Promise<OperationResult> {
    const binding = await this.#options.authorityStore.loadService(request.world_service_handle);
    if (binding.world_service_handle !== request.world_service_handle
      || binding.resolution.authorization.run_id !== request.run_id
      || binding.resolution.authorization.descriptor_digest !== request.descriptor_digest
      || !sameWorldServiceValue(binding.resolution.authorization.selected_target,
        request.selected_target)) return fail();
    const spec = worldServiceSpecForBinding(binding);
    if (spec.resultHandle !== request.world_service_handle) return fail();
    await selectedWorldServiceContextMatches(request, this.#options);
    await verifyWorldServiceResources(binding, this.#options);
    const admission = createWorldServiceMutationAdmission({
      containerId: binding.container_id,
      containerName: spec.containerName,
      operation: request.operation,
      operationHandle: claim.operationHandle,
      requestDigest: claim.requestDigest,
      worldServiceHandle: binding.world_service_handle
    });
    let current: DockerWorldServiceInspection | null;
    if (reservation === "owner") {
      current = await inspectDockerWorldService(binding.container_id, spec, this.#options);
      if (!current || current.containerId !== binding.container_id) return fail();
      if (request.operation === "start_world_service"
        && current.status !== "created" && current.status !== "exited") return fail();
      if (request.operation === "stop_world_service" && current.status === "removing") return fail();
      await this.#options.authorityStore.bindMutationAdmission(admission);
    } else {
      await this.#options.authorityStore.requireMutationAdmission(admission);
      current = await inspectDockerWorldService(binding.container_id, spec, this.#options);
    }
    if (request.operation === "start_world_service") {
      if (!current) return fail();
      if (current.status !== "running") {
        if (current.status !== "created" && current.status !== "exited") return fail();
        if (!exactMutationAck(
          await mutateDockerWorldService(
            ["container", "start", binding.container_id], this.#options
          ),
          binding.container_id
        )) return fail();
        current = await inspectDockerWorldService(binding.container_id, spec, this.#options);
      }
      if (!current || current.containerId !== binding.container_id
        || current.status !== "running") return fail();
    } else {
      if (current?.status === "running" || current?.status === "paused"
        || current?.status === "restarting") {
        if (!exactMutationAck(
          await mutateDockerWorldService(
            ["container", "stop", "--timeout", "10", binding.container_id], this.#options
          ),
          binding.container_id
        )) return fail();
        current = await inspectDockerWorldService(binding.container_id, spec, this.#options);
      }
      if (current?.status === "running" || current?.status === "paused"
        || current?.status === "restarting" || current?.status === "removing") return fail();
      if (current) {
        try {
          if (!exactMutationAck(
            await mutateDockerWorldService(
              ["container", "rm", binding.container_id], this.#options
            ),
            binding.container_id
          )) return fail();
        } catch (error) {
          if (!(error instanceof DockerWorldServiceProviderError)
            || error.kind !== "not_found") throw error;
        }
      }
      if (await inspectDockerWorldService(binding.container_id, spec, this.#options) !== null) return fail();
    }
    const resultHandle = request.operation === "start_world_service"
      ? binding.world_service_handle : null;
    const receipt = await createWorldServiceReceipt({ claim, journal: this.#options.journal,
      labels: spec.receiptLabels, request, resultHandle });
    return this.#options.journal.complete(claim, receipt);
  }
}

export const createDockerWorldServiceOperations = (
  options: DockerWorldServiceOperationsOptions
): DockerWorldServiceOperations => new DockerWorldServiceOperationsImpl(validOptions(options));
