import { SpawnfileError } from "../shared/index.js";
import {
  TARGET_RESOURCE_RECEIPT_VERSION,
  parseOpaqueTargetHandle,
  parseTargetResourceRequest,
  type OpaqueTargetHandle,
  type TargetResourceReceipt,
  type TargetResourceRequest
} from "./contracts.js";
import { createTargetReceiptDigest } from "./handles.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";

const CLEANUP_ERROR = "Target cleanup failed";
type CleanupRequest = Extract<TargetResourceRequest, { operation: "cleanup_run" }>;

export interface CleanupRunResource {
  readonly authority: unknown;
  readonly handle: OpaqueTargetHandle;
}

export interface CleanupRunPlan {
  readonly attachment: CleanupRunResource | null;
  readonly cleanupPolicy: CleanupRequest["cleanup_policy"];
  readonly dataNetwork: CleanupRunResource | null;
  readonly evidence: CleanupRunResource | null;
  readonly exportState: "exported" | "incomplete" | "not_requested";
  readonly secrets: CleanupRunResource | null;
  readonly world: CleanupRunResource | null;
}

export interface CleanupRunOperationsOptions {
  readonly journal: TargetJournalStore;
  readonly prepare: (input: {
    readonly claim: TargetJournalClaim;
    readonly request: CleanupRequest;
  }) => Promise<CleanupRunPlan>;
  readonly steps: {
    readonly detachAttachment: (resource: CleanupRunResource) => Promise<void>;
    readonly preserveEvidence: (resource: CleanupRunResource) => Promise<void>;
    readonly removeDataNetwork: (resource: CleanupRunResource) => Promise<void>;
    readonly removeEvidence: (resource: CleanupRunResource) => Promise<void>;
    readonly removeSecrets: (resource: CleanupRunResource) => Promise<void>;
    readonly removeWorld: (resource: CleanupRunResource) => Promise<void>;
  };
}

export interface CleanupRunOperations {
  execute(raw: unknown): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }>;
}

const fail = (): never => { throw new SpawnfileError("runtime_error", CLEANUP_ERROR); };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};
const request = (raw: unknown): CleanupRequest => {
  const value = parseTargetResourceRequest(raw);
  if (value.operation !== "cleanup_run"
    || value.cleanup_policy === "preserve_evidence" && value.evidence_volume_handle === undefined) return fail();
  return value;
};
const resource = (raw: unknown, expected?: OpaqueTargetHandle): CleanupRunResource => {
  if (!record(raw) || !Object.isFrozen(raw) || !exactKeys(raw, ["authority", "handle"])) return fail();
  const handle = parseOpaqueTargetHandle(raw.handle);
  if (expected !== undefined && handle !== expected) return fail();
  return raw as unknown as CleanupRunResource;
};
const optionalResource = (
  raw: unknown,
  expected: OpaqueTargetHandle | undefined
): CleanupRunResource | null => {
  if (expected === undefined) {
    if (raw !== null) return fail();
    return null;
  }
  return resource(raw, expected);
};
const plan = (raw: unknown, value: CleanupRequest): CleanupRunPlan => {
  if (!record(raw) || !Object.isFrozen(raw) || !exactKeys(raw, [
    "attachment", "cleanupPolicy", "dataNetwork", "evidence", "exportState", "secrets", "world"
  ]) || raw.cleanupPolicy !== value.cleanup_policy
    || raw.exportState !== "exported" && raw.exportState !== "incomplete"
      && raw.exportState !== "not_requested") return fail();
  const attachment = optionalResource(raw.attachment, value.organization_attachment_handle);
  const dataNetwork = raw.dataNetwork === null ? null : resource(raw.dataNetwork);
  const evidence = optionalResource(raw.evidence, value.evidence_volume_handle);
  const world = optionalResource(raw.world, value.world_service_handle);
  if ((evidence === null) !== (raw.exportState === "not_requested")
    || dataNetwork === null && (world !== null || attachment !== null)) return fail();
  return Object.freeze({
    attachment,
    cleanupPolicy: value.cleanup_policy,
    dataNetwork,
    evidence,
    exportState: raw.exportState,
    secrets: optionalResource(raw.secrets, value.secret_bindings_handle),
    world
  });
};
const receipt = (
  value: CleanupRequest,
  claim: TargetJournalClaim,
  prepared: CleanupRunPlan
): TargetResourceReceipt => {
  const raw = {
    cleanup_state: value.cleanup_policy === "preserve_evidence" ? "preserved" : "removed",
    descriptor_digest: value.descriptor_digest,
    export_state: prepared.exportState,
    labels: [] as Array<{ key: string; value: string }>,
    operation: value.operation,
    operation_handle: claim.operationHandle,
    receipt_digest: `sha256:${"0".repeat(64)}`,
    request_digest: claim.requestDigest,
    result_handle: value.cleanup_policy === "preserve_evidence"
      ? prepared.evidence!.handle : null,
    resulting_revision: value.expected_revision + 1,
    run_id: value.run_id,
    selected_target: value.selected_target,
    version: TARGET_RESOURCE_RECEIPT_VERSION
  } as const;
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) };
};

class Operations implements CleanupRunOperations {
  readonly #live = new Map<string, {
    readonly promise: Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }>;
    readonly request: CleanupRequest;
  }>();
  readonly #options: CleanupRunOperationsOptions;
  public constructor(options: CleanupRunOperationsOptions) { this.#options = options; }

  public execute(raw: unknown): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }> {
    let value: CleanupRequest;
    try { value = request(raw); } catch { return Promise.reject(new SpawnfileError("runtime_error", CLEANUP_ERROR)); }
    const active = this.#live.get(value.idempotency_key);
    if (active) return same(active.request, value) ? active.promise
      : Promise.reject(new SpawnfileError("runtime_error", CLEANUP_ERROR));
    const promise = this.#owner(value).finally(() => {
      if (this.#live.get(value.idempotency_key)?.promise === promise) {
        this.#live.delete(value.idempotency_key);
      }
    });
    this.#live.set(value.idempotency_key, { promise, request: value });
    return promise;
  }

  async #owner(value: CleanupRequest): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }> {
    try {
      const reservation = await this.#options.journal.reserve(value);
      if (reservation.kind === "replay") {
        return { receipt: reservation.receipt, receiptBytes: reservation.receiptBytes };
      }
      const prepared = plan(await this.#options.prepare({ claim: reservation.claim, request: value }), value);
      if (prepared.world) await this.#options.steps.removeWorld(prepared.world);
      if (prepared.attachment) await this.#options.steps.detachAttachment(prepared.attachment);
      if (prepared.secrets) await this.#options.steps.removeSecrets(prepared.secrets);
      if (prepared.evidence) {
        if (prepared.cleanupPolicy === "preserve_evidence") {
          await this.#options.steps.preserveEvidence(prepared.evidence);
        } else {
          await this.#options.steps.removeEvidence(prepared.evidence);
        }
      }
      if (prepared.dataNetwork) {
        await this.#options.steps.removeDataNetwork(prepared.dataNetwork);
      }
      return await this.#options.journal.complete(
        reservation.claim,
        receipt(value, reservation.claim, prepared)
      );
    } catch { return fail(); }
  }
}

export const createCleanupRunOperations = (options: CleanupRunOperationsOptions): CleanupRunOperations => {
  if (!options?.journal || typeof options.journal.reserve !== "function"
    || typeof options.journal.complete !== "function" || typeof options.prepare !== "function"
    || !options.steps || Object.values(options.steps).some((step) => typeof step !== "function")) return fail();
  return new Operations(options);
};
