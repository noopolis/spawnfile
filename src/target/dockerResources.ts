import { SpawnfileError } from "../shared/index.js";
import { parseTargetResourceRequest, type OpaqueTargetHandle, type TargetResourceReceipt, type TargetResourceRequest } from "./contracts.js";
import { selectTarget } from "./dockerTarget.js";
import { createTargetReceiptDigest } from "./handles.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";
import {
  DOCKER_RESOURCE_ERROR, DockerResourceProviderError, createDockerResourceSpec,
  executeDockerResource, isCanonicalDockerResourceSpec, isExpectedDockerResource,
  type DockerResourceExecutor, type DockerResourceKind,
  type DockerResourceSpec
} from "./dockerResourcesProvider.js";

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
export interface DockerResourceOperationsOptions {
  readonly context: unknown;
  readonly executor: DockerResourceExecutor;
  readonly journal: TargetJournalStore;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: unknown;
}

export interface DockerResourceOperations {
  execute(raw: unknown): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }>;
}

export interface DockerResourceCleanupOptions {
  readonly context: string;
  readonly executor: DockerResourceExecutor;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}
interface ValidOptions extends DockerResourceCleanupOptions {
  readonly journal: TargetJournalStore;
}
type ResourceRequest = Extract<TargetResourceRequest, { operation: "create_data_network" | "create_evidence_volume" }>;

const fail = (): never => { throw new SpawnfileError("runtime_error", DOCKER_RESOURCE_ERROR); };
const validOptions = (raw: DockerResourceOperationsOptions): ValidOptions => {
  if (typeof raw.context !== "string" || !CONTEXT_PATTERN.test(raw.context)
    || typeof raw.executor !== "function" || !raw.journal
    || typeof raw.timeoutMs !== "undefined" && (typeof raw.timeoutMs !== "number" || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 120_000)) fail();
  return { context: raw.context as string, executor: raw.executor, journal: raw.journal, signal: raw.signal, timeoutMs: (raw.timeoutMs ?? 10_000) as number };
};
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const parseResourceRequest = (raw: unknown): ResourceRequest => {
  const request = parseTargetResourceRequest(raw);
  if (request.operation !== "create_data_network" && request.operation !== "create_evidence_volume") fail();
  return request as ResourceRequest;
};

const selectedContextMatches = async (request: ResourceRequest, options: ValidOptions): Promise<void> => {
  const selected = await selectTarget({
    context: options.context, dockerCommand: "docker",
    execFile: async (_file, args, commandOptions) => executeDockerResource({ args, executor: options.executor, signal: commandOptions.signal, timeoutMs: commandOptions.timeout }),
    signal: options.signal, timeoutMs: options.timeoutMs
  });
  if (!same({ fingerprint: selected.fingerprint, handle: selected.handle }, request.selected_target)) fail();
};

const receiptFor = async (input: {
  claim: TargetJournalClaim;
  kind: DockerResourceKind;
  request: ResourceRequest;
  resultHandle: OpaqueTargetHandle;
  journal: TargetJournalStore;
}): Promise<TargetResourceReceipt> => {
  const revision = (await input.journal.read()).revision + 1;
  const labels = Object.entries(createDockerResourceSpec({
    kind: input.kind, operationHandle: input.claim.operationHandle,
    requestDigest: input.claim.requestDigest, runId: input.request.run_id, selectedTargetHandle: input.request.selected_target.handle
  }).labels).map(([key, value]) => ({ key, value }));
  const raw = {
    cleanup_state: "not_requested", descriptor_digest: input.request.descriptor_digest, export_state: "not_requested",
    labels, operation: input.request.operation, operation_handle: input.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: input.claim.requestDigest,
    result_handle: input.resultHandle, resulting_revision: revision, run_id: input.request.run_id,
    selected_target: input.request.selected_target, version: "spawnfile.target-resource.receipt.v1"
  };
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) } as TargetResourceReceipt;
};

const inspect = async (spec: DockerResourceSpec, options: DockerResourceCleanupOptions): Promise<"absent" | "present"> => {
  try {
    const result = await executeDockerResource({ args: ["--context", options.context, spec.kind === "data_network" ? "network" : "volume", "inspect", "--format", spec.inspectionFormat, spec.name], executor: options.executor, signal: options.signal, timeoutMs: options.timeoutMs });
    if (!isExpectedDockerResource(result.stdout, spec)) fail();
    return "present";
  } catch (error) { if (error instanceof DockerResourceProviderError && error.kind === "not_found") return "absent"; throw error; }
};

const validateCleanupAuthority = (
  spec: DockerResourceSpec,
  options: DockerResourceCleanupOptions
): void => {
  if (!isCanonicalDockerResourceSpec(spec)
    || !options || typeof options.context !== "string" || !CONTEXT_PATTERN.test(options.context)
    || typeof options.executor !== "function" || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1 || options.timeoutMs > 120_000) return fail();
};

export const proveExactDockerResourcePresent = async (
  spec: DockerResourceSpec,
  options: DockerResourceCleanupOptions
): Promise<void> => {
  try {
    validateCleanupAuthority(spec, options);
    if (await inspect(spec, options) !== "present") return fail();
  } catch { return fail(); }
};

export const removeExactDockerResource = async (
  spec: DockerResourceSpec,
  options: DockerResourceCleanupOptions
): Promise<void> => {
  try {
    validateCleanupAuthority(spec, options);
    if (await inspect(spec, options) === "absent") return;
    let removalError: unknown;
    let removalResult: { readonly stderr: string; readonly stdout: string } | undefined;
    try {
      removalResult = await executeDockerResource({
        args: ["--context", options.context,
          spec.kind === "data_network" ? "network" : "volume", "rm", spec.name],
        executor: options.executor,
        signal: options.signal,
        timeoutMs: options.timeoutMs
      });
    } catch (error) {
      removalError = error;
    }
    if (removalResult
      && (removalResult.stderr !== "" || removalResult.stdout !== `${spec.name}\n`)) return fail();
    if (await inspect(spec, options) !== "absent") {
      if (removalError) throw removalError;
      return fail();
    }
  } catch { return fail(); }
};

const create = async (spec: ReturnType<typeof createDockerResourceSpec>, options: ValidOptions): Promise<void> => {
  try { await executeDockerResource({ args: ["--context", options.context, ...spec.args], executor: options.executor, signal: options.signal, timeoutMs: options.timeoutMs }); }
  catch (error) {
    if (!(error instanceof DockerResourceProviderError) || error.kind !== "collision") throw error;
    if (await inspect(spec, options) !== "present") fail();
  }
};

class DockerResourceOperationsImpl implements DockerResourceOperations {
  readonly #options: ValidOptions;
  readonly #live = new Map<string, { readonly request: ResourceRequest; readonly promise: Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }> }>();
  public constructor(options: ValidOptions) { this.#options = options; }
  public execute(raw: unknown): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }> {
    let request: ResourceRequest;
    try { request = parseResourceRequest(raw); } catch { return Promise.reject(new SpawnfileError("runtime_error", DOCKER_RESOURCE_ERROR)); }
    const active = this.#live.get(request.idempotency_key);
    if (active) return same(active.request, request) ? active.promise : Promise.reject(new SpawnfileError("runtime_error", DOCKER_RESOURCE_ERROR));
    let resolve!: (value: { readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }>((accept, refuse) => { resolve = accept; reject = refuse; });
    this.#live.set(request.idempotency_key, { request, promise });
    void this.executeOwner(request).then(resolve, reject).finally(() => { if (this.#live.get(request.idempotency_key)?.promise === promise) this.#live.delete(request.idempotency_key); });
    return promise;
  }
  private async executeOwner(request: ResourceRequest): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }> {
    try {
      const kind = request.operation === "create_data_network" ? "data_network" : "evidence_volume";
      const reservation = await this.#options.journal.reserve(request);
      if (reservation.kind === "replay") return { receipt: reservation.receipt, receiptBytes: reservation.receiptBytes };
      await selectedContextMatches(request, this.#options);
      const spec = createDockerResourceSpec({ kind, operationHandle: reservation.claim.operationHandle, requestDigest: reservation.claim.requestDigest, runId: request.run_id, selectedTargetHandle: request.selected_target.handle });
      const pendingState = reservation.kind === "pending" ? await inspect(spec, this.#options) : undefined;
      if (reservation.kind === "owner" || pendingState === "absent") await create(spec, this.#options);
      const receipt = await receiptFor({ claim: reservation.claim, kind, request, resultHandle: spec.resultHandle, journal: this.#options.journal });
      return await this.#options.journal.complete(reservation.claim, receipt);
    } catch { return fail(); }
  }
}

export const createDockerResourceOperations = (options: DockerResourceOperationsOptions): DockerResourceOperations => new DockerResourceOperationsImpl(validOptions(options));
export const createDockerResources = createDockerResourceOperations;
