import { Buffer } from "node:buffer";

import { SpawnfileError } from "../shared/index.js";
import {
  parseOpaqueTargetHandle,
  parseTargetResourceRequest,
  type OpaqueTargetHandle,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import { selectTarget } from "./dockerTarget.js";
import { createTargetReceiptDigest } from "./handles.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";
import {
  createTargetSecretSourceAuthorization,
  parseTargetSecretSourceAuthorization,
  type TargetSecretSourceAuthorization,
  type TargetSecretVersionAuthorityStore,
  type TargetSecretVersionBinding
} from "./dockerSecretsAuthority.js";
import {
  DOCKER_SECRET_ERROR,
  DockerSecretProviderError,
  createDockerSecretArchive,
  createExistingDockerSecretSpec,
  createPreparedDockerSecretSpec,
  type DockerSecretExecutor,
  type DockerSecretSpec,
  type ResolvedSecretBinding
} from "./dockerSecretsProvider.js";
import {
  cleanupExactDockerSecretBindings,
  executeSecretLifecycleCommand,
  inspectExactSecretVolume,
  inspectExactSecretWriter
} from "./dockerSecretsLifecycle.js";

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
type PrepareRequest = Extract<TargetResourceRequest, { operation: "prepare_secret_bindings" }>;
type RevokeRequest = Extract<TargetResourceRequest, { operation: "revoke_secret_bindings" }>;
type SecretRequest = PrepareRequest | RevokeRequest;
type OperationResult = { readonly receipt: TargetResourceReceipt; readonly receiptBytes: string };

export interface TargetSecretSourceResolverInput {
  readonly authorization: TargetSecretSourceAuthorization;
  readonly signal?: AbortSignal;
}

export interface TargetSecretSourceResolution {
  readonly authorization: TargetSecretSourceAuthorization;
  readonly sourceVersionHandle: OpaqueTargetHandle;
  readonly value: Uint8Array;
}

/**
 * Trusted operator seam. Returned bytes transfer to the caller and are zeroed
 * after the one stdin write; a source handle must resolve immutably on retry.
 */
export interface TargetSecretSourceResolver {
  resolve(input: TargetSecretSourceResolverInput): Promise<TargetSecretSourceResolution>;
}

export interface DockerSecretOperationsOptions {
  readonly authorityStore: TargetSecretVersionAuthorityStore;
  readonly context: unknown;
  readonly executor: DockerSecretExecutor;
  readonly journal: TargetJournalStore;
  readonly resolver: TargetSecretSourceResolver;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: unknown;
}

export interface DockerSecretOperations {
  execute(raw: unknown): Promise<OperationResult>;
}

interface ValidOptions {
  readonly authorityStore: TargetSecretVersionAuthorityStore;
  readonly context: string;
  readonly executor: DockerSecretExecutor;
  readonly journal: TargetJournalStore;
  readonly resolver: TargetSecretSourceResolver;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

const fail = (): never => { throw new SpawnfileError("runtime_error", DOCKER_SECRET_ERROR); };
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const validOptions = (raw: DockerSecretOperationsOptions): ValidOptions => {
  if (!raw.authorityStore || typeof raw.authorityStore.bind !== "function"
    || typeof raw.context !== "string" || !CONTEXT_PATTERN.test(raw.context)
    || typeof raw.executor !== "function" || !raw.journal || !raw.resolver || typeof raw.resolver.resolve !== "function"
    || typeof raw.timeoutMs !== "undefined" && (typeof raw.timeoutMs !== "number" || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 120_000)) fail();
  return {
    authorityStore: raw.authorityStore, context: raw.context as string, executor: raw.executor, journal: raw.journal,
    resolver: raw.resolver, signal: raw.signal, timeoutMs: (raw.timeoutMs ?? 30_000) as number
  };
};

const parseSecretRequest = (raw: unknown): SecretRequest => {
  const request = parseTargetResourceRequest(raw);
  if (request.operation !== "prepare_secret_bindings" && request.operation !== "revoke_secret_bindings") fail();
  if (request.operation === "prepare_secret_bindings") {
    const keys = request.bindings.map((binding) => `${binding.scope}\0${binding.name}`);
    const sources = request.bindings.map((binding) => binding.source_handle);
    if (new Set(keys).size !== keys.length || new Set(sources).size !== sources.length) fail();
  }
  return request as SecretRequest;
};

const command = async (args: string[], options: ValidOptions, input?: { readonly requireSilent?: boolean; readonly stdin?: Uint8Array }): Promise<{ stderr: string; stdout: string }> =>
  executeSecretLifecycleCommand(args, options, input);

const selectedContextMatches = async (request: SecretRequest, options: ValidOptions): Promise<void> => {
  const selected = await selectTarget({
    context: options.context,
    dockerCommand: "docker",
    execFile: async (_file, args, commandOptions) => command(args, { ...options, signal: commandOptions.signal, timeoutMs: commandOptions.timeout }),
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  if (!same({ fingerprint: selected.fingerprint, handle: selected.handle }, request.selected_target)) fail();
};

const inspectVolume = (spec: DockerSecretSpec, options: ValidOptions): Promise<"absent" | "present"> =>
  inspectExactSecretVolume(spec, options);

const createVolume = async (spec: DockerSecretSpec, options: ValidOptions): Promise<void> => {
  const labels = Object.entries(spec.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const result = await command(["--context", options.context, "volume", "create", "--driver", "local", ...labels, spec.volumeName], options);
  if (result.stderr !== "" || result.stdout.trim() !== spec.volumeName || await inspectVolume(spec, options) !== "present") fail();
};

const inspectWriter = (spec: DockerSecretSpec, options: ValidOptions) =>
  inspectExactSecretWriter(spec, options);

const removePrepareWriter = async (
  spec: DockerSecretSpec,
  options: ValidOptions
): Promise<void> => {
  try {
    const result = await command(["--context", options.context, "container", "rm", "--force", spec.writerName], options);
    if (result.stderr !== "" || result.stdout.trim() !== spec.writerName) fail();
  } catch (error) { if (!(error instanceof DockerSecretProviderError) || error.kind !== "not_found") throw error; }
};

const waitWriter = async (spec: DockerSecretSpec, options: ValidOptions): Promise<boolean> => {
  try {
    const result = await command(["--context", options.context, "container", "wait", spec.writerName], options);
    if (result.stderr !== "" || !/^[0-9]{1,3}\n?$/u.test(result.stdout)) fail();
    return Number(result.stdout.trim()) === 0;
  } catch (error) { if (error instanceof DockerSecretProviderError && error.kind === "not_found") return false; throw error; }
};

const recoverWriter = async (spec: DockerSecretSpec, options: ValidOptions): Promise<boolean> => {
  const state = await inspectWriter(spec, options); if (state === "absent") return false;
  if (state.status === "running" && await waitWriter(spec, options)) return true;
  await removePrepareWriter(spec, options); return false;
};

const runWriter = async (spec: DockerSecretSpec, archive: Uint8Array, options: ValidOptions): Promise<void> => {
  try {
    await command(["--context", options.context, ...spec.writerRunArgs], options, { requireSilent: true, stdin: archive });
  } catch (error) {
    if (!(error instanceof DockerSecretProviderError) || error.kind !== "collision") throw error;
    if (await recoverWriter(spec, options)) return;
    await command(["--context", options.context, ...spec.writerRunArgs], options, { requireSilent: true, stdin: archive });
  }
};

const exactResolution = (raw: unknown): TargetSecretSourceResolution => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const keys = Reflect.ownKeys(raw); if (keys.length !== 3
    || !["authorization", "sourceVersionHandle", "value"].every((key) => keys.includes(key))) return fail();
  const record = raw as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
  }
  if (!(record.value instanceof Uint8Array)) return fail();
  return {
    authorization: parseTargetSecretSourceAuthorization(record.authorization),
    sourceVersionHandle: parseOpaqueTargetHandle(record.sourceVersionHandle),
    value: record.value
  };
};

const resolveArchive = async (request: PrepareRequest, claim: TargetJournalClaim, options: ValidOptions): Promise<Buffer> => {
  const resolved: Array<ResolvedSecretBinding & { value: Buffer }> = [];
  const versions: TargetSecretVersionBinding[] = [];
  try {
    const sorted = [...request.bindings].sort((left, right) => left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
    for (const binding of sorted) {
      let source: Uint8Array | undefined;
      try {
        const authorization = createTargetSecretSourceAuthorization({
          descriptorDigest: request.descriptor_digest, name: binding.name,
          operationHandle: claim.operationHandle, requestDigest: claim.requestDigest, runId: request.run_id,
          scope: binding.scope, selectedTarget: request.selected_target, sourceHandle: binding.source_handle
        });
        const rawResolution: unknown = await options.resolver.resolve({ authorization, signal: options.signal });
        if (rawResolution && typeof rawResolution === "object") {
          const value = Object.getOwnPropertyDescriptor(rawResolution, "value");
          if (value && "value" in value && value.value instanceof Uint8Array) source = value.value;
        }
        const resolution = exactResolution(rawResolution);
        if (!same(resolution.authorization, authorization)) fail();
        source = resolution.value;
        versions.push({ authorization, sourceVersionHandle: resolution.sourceVersionHandle });
        resolved.push({ name: binding.name, scope: binding.scope, value: Buffer.from(source) });
      } finally { if (source instanceof Uint8Array) source.fill(0); }
    }
    await options.authorityStore.bind(versions);
    return createDockerSecretArchive(resolved);
  } catch { return fail(); }
  finally { for (const binding of resolved) binding.value.fill(0); }
};

const receiptFor = (input: {
  claim: TargetJournalClaim;
  request: SecretRequest;
  resultHandle: OpaqueTargetHandle | null;
  spec: DockerSecretSpec;
}): TargetResourceReceipt => {
  const labels = Object.entries(input.spec.labels).map(([key, value]) => ({ key, value }));
  const raw = {
    cleanup_state: "not_requested", descriptor_digest: input.request.descriptor_digest, export_state: "not_requested",
    labels, operation: input.request.operation, operation_handle: input.claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: input.claim.requestDigest,
    result_handle: input.resultHandle, resulting_revision: input.request.expected_revision + 1,
    run_id: input.request.run_id, selected_target: input.request.selected_target,
    version: "spawnfile.target-resource.receipt.v1"
  };
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) } as TargetResourceReceipt;
};

class DockerSecretOperationsImpl implements DockerSecretOperations {
  readonly #options: ValidOptions;
  readonly #live = new Map<string, { readonly promise: Promise<OperationResult>; readonly request: SecretRequest }>();
  public constructor(options: ValidOptions) { this.#options = options; }
  public execute(raw: unknown): Promise<OperationResult> {
    let request: SecretRequest;
    try { request = parseSecretRequest(raw); } catch { return Promise.reject(new SpawnfileError("runtime_error", DOCKER_SECRET_ERROR)); }
    const active = this.#live.get(request.idempotency_key);
    if (active) return same(active.request, request) ? active.promise : Promise.reject(new SpawnfileError("runtime_error", DOCKER_SECRET_ERROR));
    const promise = this.executeOwner(request);
    this.#live.set(request.idempotency_key, { promise, request });
    void promise.finally(() => { if (this.#live.get(request.idempotency_key)?.promise === promise) this.#live.delete(request.idempotency_key); }).catch(() => undefined);
    return promise;
  }
  private async executeOwner(request: SecretRequest): Promise<OperationResult> {
    try {
      const reservation = await this.#options.journal.reserve(request);
      if (reservation.kind === "replay") return { receipt: reservation.receipt, receiptBytes: reservation.receiptBytes };
      await selectedContextMatches(request, this.#options);
      if (request.operation === "prepare_secret_bindings") return await this.prepare(request, reservation, reservation.claim);
      return await this.revoke(request, reservation.claim);
    } catch { return fail(); }
  }
  private async prepare(request: PrepareRequest, reservation: Exclude<Awaited<ReturnType<TargetJournalStore["reserve"]>>, { kind: "replay" }>, claim: TargetJournalClaim): Promise<OperationResult> {
    const spec = createPreparedDockerSecretSpec({ operationHandle: claim.operationHandle, requestDigest: claim.requestDigest, runId: request.run_id, selectedTargetHandle: request.selected_target.handle });
    const archive = await resolveArchive(request, claim, this.#options);
    try {
      const volumeState = await inspectVolume(spec, this.#options);
      const writerState = await inspectWriter(spec, this.#options);
      if (reservation.kind === "owner" && writerState !== "absent") fail();
      if (writerState !== "absent") {
        if (volumeState !== "present") fail();
        if (await recoverWriter(spec, this.#options)) {
          const receipt = receiptFor({ claim, request, resultHandle: spec.resultHandle, spec }); return await this.#options.journal.complete(claim, receipt);
        }
      }
      if (volumeState === "absent") await createVolume(spec, this.#options);
      await runWriter(spec, archive, this.#options);
    } finally { archive.fill(0); }
    const receipt = receiptFor({ claim, request, resultHandle: spec.resultHandle, spec }); return await this.#options.journal.complete(claim, receipt);
  }
  private async revoke(request: RevokeRequest, claim: TargetJournalClaim): Promise<OperationResult> {
    const spec = createExistingDockerSecretSpec({ bindingsHandle: request.secret_bindings_handle, runId: request.run_id, selectedTargetHandle: request.selected_target.handle });
    await cleanupExactDockerSecretBindings({
      bindingsHandle: request.secret_bindings_handle,
      runId: request.run_id,
      selectedTargetHandle: request.selected_target.handle
    }, this.#options);
    const receipt = receiptFor({ claim, request, resultHandle: null, spec }); return await this.#options.journal.complete(claim, receipt);
  }
}

export const createDockerSecretOperations = (options: DockerSecretOperationsOptions): DockerSecretOperations => new DockerSecretOperationsImpl(validOptions(options));
export const createDockerSecrets = createDockerSecretOperations;
