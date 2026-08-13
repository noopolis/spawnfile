import { SpawnfileError } from "../shared/index.js";
import { parseTargetResourceRequest, type OpaqueTargetHandle, type TargetResourceReceipt, type TargetResourceRequest } from "./contracts.js";
import {
  DOCKER_ARTIFACT_ERROR, createDockerArtifactSpec, executeDockerArtifact, isExpectedDockerArtifact,
  parseDockerArtifactMappings, type DockerArtifactExecutor, type DockerArtifactIdentityStore, type DockerArtifactMapping
} from "./dockerArtifactsProvider.js";
import { selectTarget } from "./dockerTarget.js";
import { createTargetReceiptDigest } from "./handles.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";

const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
type ArtifactRequest = Extract<TargetResourceRequest, { operation: "resolve_world_artifact" }>;
type ArtifactResult = { readonly receipt: TargetResourceReceipt; readonly receiptBytes: string };

export interface DockerArtifactOperationsOptions {
  readonly context: unknown;
  readonly executor: DockerArtifactExecutor;
  readonly identityStore: DockerArtifactIdentityStore;
  readonly journal: TargetJournalStore;
  readonly mappings: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: unknown;
}

export interface DockerArtifactOperations { execute(raw: unknown): Promise<ArtifactResult>; }

interface ValidOptions {
  readonly context: string;
  readonly executor: DockerArtifactExecutor;
  readonly identityStore: DockerArtifactIdentityStore;
  readonly journal: TargetJournalStore;
  readonly mappings: readonly DockerArtifactMapping[];
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

const fail = (): never => { throw new SpawnfileError("runtime_error", DOCKER_ARTIFACT_ERROR); };
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const exactContext = (value: string): boolean => CONTEXT_PATTERN.exec(value)?.[0] === value;
const validOptions = (raw: DockerArtifactOperationsOptions): ValidOptions => {
  try {
    if (typeof raw.context !== "string" || !exactContext(raw.context)
      || typeof raw.executor !== "function" || !raw.identityStore || typeof raw.identityStore.bind !== "function" || !raw.journal
      || typeof raw.timeoutMs !== "undefined" && (typeof raw.timeoutMs !== "number" || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 120_000)) return fail();
    return {
      context: raw.context, executor: raw.executor, identityStore: raw.identityStore, journal: raw.journal,
      mappings: parseDockerArtifactMappings(raw.mappings), signal: raw.signal, timeoutMs: raw.timeoutMs ?? 10_000
    };
  } catch { return fail(); }
};
const parseRequest = (raw: unknown): ArtifactRequest => {
  const request = parseTargetResourceRequest(raw);
  if (request.operation !== "resolve_world_artifact") return fail();
  return request as ArtifactRequest;
};
const mappingFor = (request: ArtifactRequest, options: ValidOptions): DockerArtifactMapping =>
  options.mappings.find((mapping) => mapping.artifact_manifest_digest === request.artifact_manifest_digest) ?? fail();

const selectedContextMatches = async (request: ArtifactRequest, options: ValidOptions): Promise<void> => {
  const selected = await selectTarget({
    context: options.context, dockerCommand: "docker",
    execFile: async (_file, args, commandOptions) => executeDockerArtifact({ args, executor: options.executor, signal: commandOptions.signal, timeoutMs: commandOptions.timeout }),
    signal: options.signal, timeoutMs: options.timeoutMs
  });
  if (!same({ fingerprint: selected.fingerprint, handle: selected.handle }, request.selected_target)) return fail();
};

const receiptFor = async (input: {
  claim: TargetJournalClaim;
  journal: TargetJournalStore;
  labels: Readonly<Record<string, string>>;
  request: ArtifactRequest;
  resultHandle: OpaqueTargetHandle;
}): Promise<TargetResourceReceipt> => {
  const revision = (await input.journal.read()).revision + 1;
  const raw = {
    cleanup_state: "not_requested", descriptor_digest: input.request.descriptor_digest, export_state: "not_requested",
    labels: Object.entries(input.labels).map(([key, value]) => ({ key, value })), operation: input.request.operation,
    operation_handle: input.claim.operationHandle, receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: input.claim.requestDigest, result_handle: input.resultHandle, resulting_revision: revision,
    run_id: input.request.run_id, selected_target: input.request.selected_target, version: "spawnfile.target-resource.receipt.v1"
  };
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) } as TargetResourceReceipt;
};

class DockerArtifactOperationsImpl implements DockerArtifactOperations {
  readonly #live = new Map<string, { readonly promise: Promise<ArtifactResult>; readonly request: ArtifactRequest }>();
  readonly #options: ValidOptions;
  public constructor(options: ValidOptions) { this.#options = options; }

  public execute(raw: unknown): Promise<ArtifactResult> {
    let request: ArtifactRequest; let mapping: DockerArtifactMapping;
    try { request = parseRequest(raw); mapping = mappingFor(request, this.#options); }
    catch { return Promise.reject(new SpawnfileError("runtime_error", DOCKER_ARTIFACT_ERROR)); }
    const active = this.#live.get(request.idempotency_key);
    if (active) return same(active.request, request) ? active.promise : Promise.reject(new SpawnfileError("runtime_error", DOCKER_ARTIFACT_ERROR));
    let resolve!: (value: ArtifactResult) => void; let reject!: (reason: unknown) => void;
    const promise = new Promise<ArtifactResult>((accept, refuse) => { resolve = accept; reject = refuse; });
    this.#live.set(request.idempotency_key, { promise, request });
    void this.executeOwner(request, mapping).then(resolve, reject).finally(() => {
      if (this.#live.get(request.idempotency_key)?.promise === promise) this.#live.delete(request.idempotency_key);
    });
    return promise;
  }

  private async executeOwner(request: ArtifactRequest, mapping: DockerArtifactMapping): Promise<ArtifactResult> {
    try {
      const reservation = await this.#options.journal.reserve(request);
      if (reservation.kind === "replay") return { receipt: reservation.receipt, receiptBytes: reservation.receiptBytes };
      const spec = createDockerArtifactSpec({
        artifactManifestDigest: request.artifact_manifest_digest, imageDigest: mapping.image_digest,
        imageReference: mapping.image_reference, operationHandle: reservation.claim.operationHandle,
        requestDigest: reservation.claim.requestDigest, selectedTargetHandle: request.selected_target.handle
      });
      await this.#options.identityStore.bind({
        artifactManifestDigest: request.artifact_manifest_digest, imageDigest: mapping.image_digest,
        imageReference: mapping.image_reference, operationHandle: reservation.claim.operationHandle,
        requestDigest: reservation.claim.requestDigest, resultHandle: spec.resultHandle,
        selectedTargetHandle: request.selected_target.handle
      });
      await selectedContextMatches(request, this.#options);
      const result = await executeDockerArtifact({
        args: ["--context", this.#options.context, "image", "inspect", "--format", spec.inspectionFormat, spec.imageReference],
        executor: this.#options.executor, signal: this.#options.signal, timeoutMs: this.#options.timeoutMs
      });
      if (!isExpectedDockerArtifact(result.stdout, spec)) return fail();
      const receipt = await receiptFor({ claim: reservation.claim, journal: this.#options.journal, labels: spec.labels, request, resultHandle: spec.resultHandle });
      return await this.#options.journal.complete(reservation.claim, receipt);
    } catch { return fail(); }
  }
}

export const createDockerArtifactOperations = (options: DockerArtifactOperationsOptions): DockerArtifactOperations =>
  new DockerArtifactOperationsImpl(validOptions(options));
