import { createHash, randomUUID } from "node:crypto";

import {
  createTargetLocalBundleRequestDigest,
  parseTargetLocalBundlePrepareReceipt,
  parseTargetLocalBundlePrepareRequest,
  type TargetLocalBundleLookup,
  type TargetLocalBundlePrepareReceipt,
  type TargetLocalBundlePrepareRequest
} from "./containerBundleContracts.js";
import { parseOpaqueTargetHandle, type OpaqueTargetHandle } from "./contracts.js";

const MAX_RECORDS = 128;
const LEASE_MS = 30_000;
const MAX_AWAIT_REPLAY_MS = 30_000;
const AWAIT_REPLAY_INTERVAL_MS = 25;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TAG = /^spfb_[a-f0-9]{58}$/u;
const LEASE = /^lease_[a-f0-9]{32}$/u;
const fail = (): never => { throw new Error("Container bundle store failed"); };

export interface TargetLocalBundlePrivateMapping {
  readonly archive_digest: string;
  readonly artifact_digest: string;
  readonly base_image_config_digest: string;
  readonly build_policy_digest: string;
  readonly bundle_digest: string;
  readonly config_id: string;
  readonly daemon_epoch: string;
  readonly entrypoint: string;
  readonly gc_tag: string;
  readonly identity_kind: "docker_image_config_digest";
  readonly launcher_digest: string;
  readonly network_alias: string;
  readonly operation_handle: OpaqueTargetHandle;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly platform_digest: string;
  readonly request_digest: string;
  readonly selected_target: TargetLocalBundlePrepareRequest["selected_target"];
}
export interface TargetLocalBundleLease {
  readonly generation: number;
  readonly lease_id: string;
  readonly operation_handle: OpaqueTargetHandle;
  readonly request_digest: string;
}
export type TargetLocalBundleWorkState = "prebuild" | "inflight" | "postbuild";
export type TargetLocalBundleReservation =
  | { readonly kind: "owner"; readonly lease: TargetLocalBundleLease; readonly mapping?: TargetLocalBundlePrivateMapping; readonly operation_handle: OpaqueTargetHandle; readonly request_digest: string; readonly state: TargetLocalBundleWorkState }
  | { readonly generation: number; readonly kind: "replay"; readonly mapping: TargetLocalBundlePrivateMapping; readonly receipt: TargetLocalBundlePrepareReceipt }
  | { readonly kind: "pending"; readonly operation_handle: OpaqueTargetHandle; readonly request_digest: string; readonly state: TargetLocalBundleWorkState }
  | { readonly kind: "incomplete"; readonly operation_handle: OpaqueTargetHandle; readonly request_digest: string };
export interface TargetLocalBundleStore {
  /** Read-only, bounded join for another durable owner. It never reserves or recovers work. */
  awaitReplay(input: { readonly idempotency_key: unknown; readonly maximum_wait_ms: unknown; readonly request_digest: unknown }): Promise<TargetLocalBundleLookup>;
  beginBuild(input: { readonly lease: unknown }): Promise<TargetLocalBundleLease>;
  complete(input: { readonly lease: unknown; readonly mapping: TargetLocalBundlePrivateMapping; readonly receipt: unknown }): Promise<TargetLocalBundlePrepareReceipt>;
  lookup(input: { readonly idempotency_key: unknown; readonly request_digest: unknown }): Promise<TargetLocalBundleLookup>;
  markIncomplete(input: { readonly lease: unknown; readonly operation_handle: unknown; readonly request_digest: unknown }): Promise<void>;
  reserve(raw: unknown): Promise<TargetLocalBundleReservation>;
  renew(input: { readonly lease: unknown }): Promise<TargetLocalBundleLease>;
  /** Atomically reclaims only the completed generation whose exact anchor was proven absent. */
  retryMissingCompleted(input: { readonly generation: unknown; readonly operation_handle: unknown; readonly request_digest: unknown }): Promise<TargetLocalBundleReservation>;
  /** A reclaimed owner may retry only a proven absent pre-effect. */
  retryPrebuild(input: { readonly lease: unknown }): Promise<TargetLocalBundleLease>;
  resolve(input: { readonly operation_handle: unknown; readonly request_digest: unknown }): Promise<TargetLocalBundlePrivateMapping | null>;
  resolvePrepared(input: { readonly artifact_digest: unknown; readonly build_policy_digest: unknown; readonly bundle_digest: unknown; readonly selected_target: unknown }): Promise<{ readonly mapping: TargetLocalBundlePrivateMapping; readonly request: TargetLocalBundlePrepareRequest } | null>;
  stagePostbuild(input: { readonly lease: unknown; readonly mapping: TargetLocalBundlePrivateMapping }): Promise<TargetLocalBundleLease>;
}
export interface TargetLocalBundleStoredRecord {
  readonly generation: number;
  readonly idempotency_key: string;
  readonly lease_expires_at: number | null;
  readonly lease_id: string | null;
  readonly mapping?: TargetLocalBundlePrivateMapping;
  readonly operation_handle: OpaqueTargetHandle;
  readonly receipt?: TargetLocalBundlePrepareReceipt;
  readonly request: TargetLocalBundlePrepareRequest;
  readonly request_digest: string;
  readonly state: TargetLocalBundleWorkState | "completed" | "incomplete";
}
export interface TargetLocalBundleMemoryStore extends TargetLocalBundleStore {
  restore(records: readonly unknown[]): void;
  snapshot(): readonly TargetLocalBundleStoredRecord[];
}

type BundleRecord = {
  generation: number;
  idempotency_key: string;
  lease_expires_at: number | null;
  lease_id: string | null;
  mapping?: TargetLocalBundlePrivateMapping;
  operation_handle: OpaqueTargetHandle;
  receipt?: TargetLocalBundlePrepareReceipt;
  request: TargetLocalBundlePrepareRequest;
  request_digest: string;
  state: TargetLocalBundleWorkState | "completed" | "incomplete";
};
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const handle = (requestDigest: string): OpaqueTargetHandle => parseOpaqueTargetHandle(`opaque_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.operation.v1\0", "utf8").update(requestDigest).digest("hex")}`);
const mappingHandle = (operation: OpaqueTargetHandle, requestDigest: string): OpaqueTargetHandle => parseOpaqueTargetHandle(`opaque_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.mapping.v1\0", "utf8").update(`${operation}\0${requestDigest}`, "utf8").digest("hex")}`);
const tag = (requestDigest: string): string => `spfb_${createHash("sha256")
  .update("spawnfile.target-local-container-bundle.gc-tag.v1\0", "utf8").update(requestDigest).digest("hex").slice(0, 58)}`;
const leaseId = (): string => `lease_${randomUUID().replaceAll("-", "")}`;
const now = (): number => Date.now();
const frozen = <T extends object>(value: T): T => Object.freeze(value);
const validLease = (raw: unknown): TargetLocalBundleLease => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as globalThis.Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== "generation\0lease_id\0operation_handle\0request_digest"
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || typeof value.lease_id !== "string" || !LEASE.test(value.lease_id)
    || typeof value.request_digest !== "string" || !DIGEST.test(value.request_digest)) return fail();
  return frozen({ generation: value.generation as number, lease_id: value.lease_id,
    operation_handle: parseOpaqueTargetHandle(value.operation_handle), request_digest: value.request_digest });
};
const validMapping = (raw: unknown): TargetLocalBundlePrivateMapping => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as globalThis.Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== "archive_digest\0artifact_digest\0base_image_config_digest\0build_policy_digest\0bundle_digest\0config_id\0daemon_epoch\0entrypoint\0gc_tag\0identity_kind\0launcher_digest\0network_alias\0operation_handle\0platform\0platform_digest\0request_digest\0selected_target"
    || typeof value.archive_digest !== "string" || !DIGEST.test(value.archive_digest)
    || typeof value.artifact_digest !== "string" || !DIGEST.test(value.artifact_digest)
    || typeof value.base_image_config_digest !== "string" || !DIGEST.test(value.base_image_config_digest)
    || typeof value.build_policy_digest !== "string" || !DIGEST.test(value.build_policy_digest)
    || typeof value.bundle_digest !== "string" || !DIGEST.test(value.bundle_digest)
    || typeof value.config_id !== "string" || !DIGEST.test(value.config_id)
    || typeof value.daemon_epoch !== "string" || !DIGEST.test(value.daemon_epoch)
    || typeof value.entrypoint !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value.entrypoint)
    || typeof value.gc_tag !== "string" || !TAG.test(value.gc_tag)
    || value.identity_kind !== "docker_image_config_digest" || typeof value.launcher_digest !== "string" || !DIGEST.test(value.launcher_digest)
    || typeof value.network_alias !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(value.network_alias)
    || typeof value.platform_digest !== "string" || !DIGEST.test(value.platform_digest)
    || typeof value.request_digest !== "string" || !DIGEST.test(value.request_digest)) return fail();
  const entries = [value.entrypoint];
  const request = parseTargetLocalBundlePrepareRequest({ archive_base64: "", archive_digest: value.archive_digest, archive_entries: entries,
    artifact_digest: value.artifact_digest, build_policy_digest: value.build_policy_digest, bundle_digest: value.bundle_digest, entrypoint: value.entrypoint,
    idempotency_key: "idem_abcdefghijklmnop", launcher_digest: value.launcher_digest, network_alias: value.network_alias,
    platform: value.platform, platform_digest: value.platform_digest, selected_target: value.selected_target, version: "spawnfile.target-local-container-bundle.prepare-request.v1" });
  return frozen({ archive_digest: value.archive_digest, artifact_digest: value.artifact_digest, base_image_config_digest: value.base_image_config_digest,
    build_policy_digest: value.build_policy_digest, bundle_digest: value.bundle_digest, config_id: value.config_id, daemon_epoch: value.daemon_epoch,
    entrypoint: request.entrypoint, gc_tag: value.gc_tag, identity_kind: value.identity_kind, launcher_digest: value.launcher_digest,
    network_alias: value.network_alias, operation_handle: parseOpaqueTargetHandle(value.operation_handle), platform: request.platform,
    platform_digest: value.platform_digest, request_digest: value.request_digest, selected_target: request.selected_target });
};
const matchesRequest = (mapping: TargetLocalBundlePrivateMapping, request: TargetLocalBundlePrepareRequest): boolean =>
  mapping.archive_digest === request.archive_digest && mapping.artifact_digest === request.artifact_digest
  && mapping.build_policy_digest === request.build_policy_digest && mapping.bundle_digest === request.bundle_digest
  && mapping.entrypoint === request.entrypoint && mapping.launcher_digest === request.launcher_digest
  && mapping.network_alias === request.network_alias && equal(mapping.platform, request.platform)
  && mapping.platform_digest === request.platform_digest && equal(mapping.selected_target, request.selected_target);
const sameRequestReceipt = (request: TargetLocalBundlePrepareRequest, receipt: TargetLocalBundlePrepareReceipt, operation: OpaqueTargetHandle, requestDigest: string): boolean =>
  receipt.mapping_handle === mappingHandle(operation, requestDigest) && receipt.operation_handle === operation && receipt.request_digest === requestDigest
  && receipt.archive_digest === request.archive_digest && receipt.artifact_digest === request.artifact_digest
  && receipt.build_policy_digest === request.build_policy_digest && receipt.bundle_digest === request.bundle_digest
  && receipt.launcher_digest === request.launcher_digest && receipt.network_alias === request.network_alias
  && equal(receipt.platform, request.platform) && receipt.platform_digest === request.platform_digest
  && equal(receipt.selected_target, request.selected_target);
const validCorrelations = (mapping: TargetLocalBundlePrivateMapping, request: TargetLocalBundlePrepareRequest, operation: OpaqueTargetHandle, requestDigest: string): boolean =>
  mapping.gc_tag === tag(requestDigest) && mapping.operation_handle === operation
  && mapping.request_digest === requestDigest && matchesRequest(mapping, request);
const pause = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, AWAIT_REPLAY_INTERVAL_MS));
const validAwaitReplay = (raw: unknown): { readonly idempotency_key: string; readonly maximum_wait_ms: number; readonly request_digest: string } => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as globalThis.Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== "idempotency_key\0maximum_wait_ms\0request_digest"
    || typeof value.idempotency_key !== "string" || !/^idem_[a-z0-9]{16,64}$/u.test(value.idempotency_key)
    || typeof value.request_digest !== "string" || !DIGEST.test(value.request_digest)
    || !Number.isSafeInteger(value.maximum_wait_ms) || (value.maximum_wait_ms as number) < 0
    || (value.maximum_wait_ms as number) > MAX_AWAIT_REPLAY_MS) return fail();
  return frozen({ idempotency_key: value.idempotency_key, maximum_wait_ms: value.maximum_wait_ms as number, request_digest: value.request_digest });
};
const validCompletedRetry = (raw: unknown): { readonly generation: number; readonly operation_handle: OpaqueTargetHandle; readonly request_digest: string } => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as globalThis.Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== "generation\0operation_handle\0request_digest"
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || typeof value.request_digest !== "string" || !DIGEST.test(value.request_digest)) return fail();
  return frozen({ generation: value.generation as number, operation_handle: parseOpaqueTargetHandle(value.operation_handle), request_digest: value.request_digest });
};

/** Exact-key private store. It never enumerates Docker state or admits inverse config-ID lookup. */
export const createMemoryTargetLocalBundleStore = (): TargetLocalBundleMemoryStore => {
  const records = new Map<string, BundleRecord>();
  const byOperation = new Map<string, BundleRecord>();
  const key = (operation: string, requestDigest: string): string => `${operation}\0${requestDigest}`;
  const lease = (record: BundleRecord): TargetLocalBundleLease => frozen({ generation: record.generation,
    lease_id: record.lease_id!, operation_handle: record.operation_handle, request_digest: record.request_digest });
  const owns = (raw: unknown, accepted: readonly TargetLocalBundleWorkState[]): BundleRecord => {
    const candidate = validLease(raw); const record = byOperation.get(key(candidate.operation_handle, candidate.request_digest));
    if (!record || !accepted.includes(record.state as TargetLocalBundleWorkState) || record.generation !== candidate.generation
      || record.lease_id !== candidate.lease_id || record.lease_expires_at === null || record.lease_expires_at < now()) return fail();
    return record;
  };
  const persist = (record: BundleRecord, state: BundleRecord["state"]): void => {
    record.state = state;
    if (state === "completed" || state === "incomplete") {
      record.lease_id = null;
      record.lease_expires_at = null;
      return;
    }
    record.lease_expires_at = now() + LEASE_MS;
  };
  const store: TargetLocalBundleMemoryStore = {
    reserve: async (raw) => {
      const request = parseTargetLocalBundlePrepareRequest(raw); const requestDigest = createTargetLocalBundleRequestDigest(request);
      let record = records.get(request.idempotency_key);
      if (!record) {
        if (records.size >= MAX_RECORDS) return fail();
        record = { generation: 1, idempotency_key: request.idempotency_key, lease_expires_at: now() + LEASE_MS,
          lease_id: leaseId(), operation_handle: handle(requestDigest), request, request_digest: requestDigest, state: "prebuild" };
        records.set(record.idempotency_key, record); byOperation.set(key(record.operation_handle, record.request_digest), record);
        return frozen({ kind: "owner" as const, lease: lease(record), operation_handle: record.operation_handle, request_digest: record.request_digest, state: "prebuild" as const });
      }
      if (record.request_digest !== requestDigest || !equal(record.request, request)) return fail();
      if (record.state === "completed") return frozen({ generation: record.generation, kind: "replay" as const, mapping: record.mapping!, receipt: record.receipt! });
      if (record.state === "incomplete") return frozen({ kind: "incomplete" as const, operation_handle: record.operation_handle, request_digest: record.request_digest });
      if (record.lease_expires_at! >= now()) return frozen({ kind: "pending" as const, operation_handle: record.operation_handle, request_digest: record.request_digest, state: record.state });
      record.generation += 1; record.lease_id = leaseId(); record.lease_expires_at = now() + LEASE_MS;
      return frozen({ kind: "owner" as const, lease: lease(record), ...(record.mapping ? { mapping: record.mapping } : {}), operation_handle: record.operation_handle, request_digest: record.request_digest, state: record.state });
    },
    awaitReplay: async (raw) => {
      const input = validAwaitReplay(raw); const deadline = now() + input.maximum_wait_ms;
      for (;;) {
        const result = await store.lookup(input);
        if (result.status !== "pending" || now() >= deadline) return result;
        await pause();
      }
    },
    beginBuild: async ({ lease: raw }) => { const record = owns(raw, ["prebuild"]); persist(record, "inflight"); return lease(record); },
    renew: async ({ lease: raw }) => { const record = owns(raw, ["prebuild", "inflight", "postbuild"]); record.lease_expires_at = now() + LEASE_MS; return lease(record); },
    retryMissingCompleted: async (raw) => {
      const input = validCompletedRetry(raw); const record = byOperation.get(key(input.operation_handle, input.request_digest));
      if (!record || input.generation > record.generation) return fail();
      if (input.generation === record.generation && record.state === "completed") {
        record.generation += 1; record.lease_id = leaseId(); delete record.mapping; delete record.receipt; persist(record, "prebuild");
        return frozen({ kind: "owner" as const, lease: lease(record), operation_handle: record.operation_handle,
          request_digest: record.request_digest, state: "prebuild" as const });
      }
      if (record.state === "completed") return frozen({ generation: record.generation, kind: "replay" as const, mapping: record.mapping!, receipt: record.receipt! });
      if (record.state === "incomplete") return frozen({ kind: "incomplete" as const, operation_handle: record.operation_handle, request_digest: record.request_digest });
      return frozen({ kind: "pending" as const, operation_handle: record.operation_handle, request_digest: record.request_digest, state: record.state });
    },
    retryPrebuild: async ({ lease: raw }) => { const record = owns(raw, ["inflight"]); persist(record, "prebuild"); return lease(record); },
    stagePostbuild: async ({ lease: raw, mapping: rawMapping }) => {
      const record = owns(raw, ["inflight"]); const mapping = validMapping(rawMapping);
      if (!validCorrelations(mapping, record.request, record.operation_handle, record.request_digest)) return fail();
      record.mapping = mapping; persist(record, "postbuild"); return lease(record);
    },
    complete: async ({ lease: rawLease, mapping: rawMapping, receipt: rawReceipt }) => {
      const mapping = validMapping(rawMapping); const record = owns(rawLease, ["postbuild"]);
      if (!validCorrelations(mapping, record.request, record.operation_handle, record.request_digest)) return fail();
      const receipt = parseTargetLocalBundlePrepareReceipt(rawReceipt);
      if (!sameRequestReceipt(record.request, receipt, record.operation_handle, record.request_digest)) return fail();
      record.mapping = mapping; record.receipt = receipt; persist(record, "completed"); return receipt;
    },
    markIncomplete: async ({ lease: rawLease, operation_handle, request_digest }) => {
      const record = owns(rawLease, ["prebuild", "inflight", "postbuild"]);
      if (record.operation_handle !== parseOpaqueTargetHandle(operation_handle) || record.request_digest !== request_digest) return fail();
      delete record.mapping; delete record.receipt; persist(record, "incomplete");
    },
    resolve: async ({ operation_handle, request_digest }) => {
      const record = byOperation.get(key(parseOpaqueTargetHandle(operation_handle), String(request_digest)));
      return record?.state === "completed" ? record.mapping ?? null : null;
    },
    resolvePrepared: async (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
      const value = input as globalThis.Record<string, unknown>;
      if (Object.keys(value).sort().join("\0") !== "artifact_digest\0build_policy_digest\0bundle_digest\0selected_target") return fail();
      const matches = [...records.values()].filter((record) => record.state === "completed" && record.mapping
        && record.request.artifact_digest === value.artifact_digest && record.request.build_policy_digest === value.build_policy_digest
        && record.request.bundle_digest === value.bundle_digest && equal(record.request.selected_target, value.selected_target));
      if (matches.length > 1) return fail();
      const record = matches[0]; return record ? frozen({ mapping: record.mapping!, request: record.request }) : null;
    },
    lookup: async ({ idempotency_key, request_digest }) => {
      if (typeof idempotency_key !== "string" || typeof request_digest !== "string" || !DIGEST.test(request_digest)) return fail();
      const record = records.get(idempotency_key); const base = { idempotency_key, request_digest, version: "spawnfile.target-local-container-bundle.lookup.v1" as const };
      if (!record || record.request_digest !== request_digest) return frozen({ ...base, status: "not_applied" as const });
      if (record.state === "completed") return frozen({ ...base, operation_handle: record.operation_handle, receipt: record.receipt!, status: "completed" as const });
      if (record.state === "incomplete") return frozen({ ...base, status: "not_applied" as const });
      return frozen({ ...base, operation_handle: record.operation_handle, status: "pending" as const });
    },
    snapshot: () => frozen([...records.values()].map((record) => frozen({ ...record, ...(record.mapping ? { mapping: record.mapping } : {}), ...(record.receipt ? { receipt: record.receipt } : {}) }))),
    restore: (rawRecords) => {
      if (records.size !== 0 || !Array.isArray(rawRecords) || rawRecords.length > MAX_RECORDS) return fail();
      for (const raw of rawRecords) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(); const value = raw as globalThis.Record<string, unknown>;
        const baseKeys = ["generation", "idempotency_key", "lease_expires_at", "lease_id", "operation_handle", "request", "request_digest", "state"];
        if (typeof value.state !== "string" || !['prebuild', 'inflight', 'postbuild', 'completed', 'incomplete'].includes(value.state)
          || Object.keys(value).sort().join("\0") !== [...baseKeys, ...(value.state === "postbuild" || value.state === "completed" ? ["mapping"] : []), ...(value.state === "completed" ? ["receipt"] : [])].sort().join("\0")
          || typeof value.idempotency_key !== "string"
          || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 || typeof value.request_digest !== "string" || !DIGEST.test(value.request_digest)) return fail();
        const request = parseTargetLocalBundlePrepareRequest(value.request); const requestDigest = createTargetLocalBundleRequestDigest(request);
        const operation = parseOpaqueTargetHandle(value.operation_handle);
        if (request.idempotency_key !== value.idempotency_key || requestDigest !== value.request_digest || operation !== handle(requestDigest)) return fail();
        const terminal = value.state === "completed" || value.state === "incomplete";
        if ((terminal && (value.lease_id !== null || value.lease_expires_at !== null)) || (!terminal && (typeof value.lease_id !== "string" || !LEASE.test(value.lease_id) || !Number.isSafeInteger(value.lease_expires_at)))) return fail();
        const mapping = value.mapping === undefined ? undefined : validMapping(value.mapping);
        const receipt = value.receipt === undefined ? undefined : parseTargetLocalBundlePrepareReceipt(value.receipt);
        if ((value.state === "postbuild" || value.state === "completed") && !mapping || (value.state === "completed" && !receipt)) return fail();
        if (mapping && !validCorrelations(mapping, request, operation, requestDigest)
          || receipt && !sameRequestReceipt(request, receipt, operation, requestDigest)) return fail();
        const record: BundleRecord = { generation: value.generation as number, idempotency_key: value.idempotency_key, lease_expires_at: value.lease_expires_at as number | null,
          lease_id: value.lease_id as string | null, ...(mapping ? { mapping } : {}), operation_handle: operation, ...(receipt ? { receipt } : {}), request, request_digest: requestDigest, state: value.state as BundleRecord["state"] };
        if (records.has(record.idempotency_key)) return fail(); records.set(record.idempotency_key, record); byOperation.set(key(operation, requestDigest), record);
      }
    }
  };
  return frozen(store);
};
