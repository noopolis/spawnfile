import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { SpawnfileError } from "../shared/index.js";
import {
  SELECTED_TARGET_VERSION, TARGET_JOURNAL_VERSION, TARGET_OPERATION_LOOKUP_VERSION,
  parseOpaqueTargetHandle, parseRunId,
  parseSelectedTargetReceipt, parseTargetResourceJournal, parseTargetResourceReceipt,
  parseTargetOperationLookup, parseTargetResourceRequest, type OpaqueTargetHandle,
  type SelectedTargetReceipt, type TargetMutationRequest, type TargetOperationLookup,
  type TargetResourceJournal, type TargetResourceReceipt, type TargetResourceRequest
} from "./contracts.js";
import {
  createCanonicalTargetReceiptBytes, createPendingReceiptDigest, createTargetJournalIdentity,
  createTargetOperationHandle, createTargetReceiptDigest, createTargetRequestDigest, type TargetDigest
} from "./handles.js";
import {
  findExistingTargetJournalRoot, prepareTargetJournalRoot, readTargetJournalFile
} from "./journalFilesystem.js";
import { resolveTargetJournalRoot } from "./journalRoot.js";

const PRIVATE_VERSION = "spawnfile.target-resource.private-journal.v1";
const JOURNAL_ERROR = "Target journal failed";
const MAX_STORE_BYTES = 524_288;
const CONTEXT_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

type ClaimState = "completed" | "pending";
type ResultRole = "data_network" | "evidence_volume" | "organization_attachment" | "secret_bindings" | "world_artifact" | "world_service";
interface StoredClaim { readonly idempotency_key: string; readonly operation: TargetResourceRequest["operation"]; readonly operation_handle: OpaqueTargetHandle; readonly receipt_bytes?: string; readonly request_digest: TargetDigest; readonly state: ClaimState; }
interface PrivateStore { readonly adapter: { readonly context: string }; readonly claims: readonly StoredClaim[]; readonly journal: TargetResourceJournal; readonly version: typeof PRIVATE_VERSION; }

export interface InitializeTargetJournalOptions { context: unknown; descriptorDigest: unknown; root?: string; runId: unknown; selectedTarget: unknown; }
export interface TargetJournalClaim { readonly operationHandle: OpaqueTargetHandle; readonly requestDigest: TargetDigest; }
export type TargetJournalReservation = { readonly kind: "owner"; readonly claim: TargetJournalClaim } | { readonly kind: "pending"; readonly claim: TargetJournalClaim } | { readonly kind: "replay"; readonly receipt: TargetResourceReceipt; readonly receiptBytes: string };
export interface TargetJournalStore { complete(claim: TargetJournalClaim, raw: unknown): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }>; read(): Promise<TargetResourceJournal>; reserve(raw: unknown): Promise<TargetJournalReservation>; resolveCompletedReceipt(claim: TargetJournalClaim): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string } | null>; withLifecycleLease<Result>(action: () => Promise<Result>): Promise<Result>; }
export interface TargetJournalLookupStore {
  lookup(raw: unknown): Promise<TargetOperationLookup>;
}
export interface LookupTargetOperationOptions {
  context: unknown;
  request: unknown;
  root?: string;
}

interface JournalFilesystem { syncDirectory(directory: string): Promise<void>; }
const nativeFilesystem: JournalFilesystem = { syncDirectory: async (directory) => { const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } } };
let filesystem: JournalFilesystem = nativeFilesystem;
/** Test seam for observing the required post-replacement directory sync. */
export const setTargetJournalFilesystemForTests = (replacement: JournalFilesystem): (() => void) => {
  const previous = filesystem; filesystem = replacement; return () => { filesystem = previous; };
};

const fail = (): never => { throw new SpawnfileError("runtime_error", JOURNAL_ERROR); };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === keys[index]); };
const digest = (value: unknown): value is TargetDigest => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const directoryOf = (filePath: string): string => path.dirname(filePath);

const checkedRead = async (filePath: string): Promise<string | null> => {
  try { return await readTargetJournalFile(filePath, MAX_STORE_BYTES); }
  catch { return fail(); }
};

const roleForOperation: Partial<Record<TargetResourceRequest["operation"], ResultRole>> = {
  attach_organization: "organization_attachment", create_data_network: "data_network",
  create_evidence_volume: "evidence_volume", create_world_service: "world_service",
  prepare_secret_bindings: "secret_bindings", resolve_world_artifact: "world_artifact"
};
const requiredHandles = (request: TargetResourceRequest): Array<{ readonly handle: OpaqueTargetHandle; readonly role: ResultRole }> => {
  switch (request.operation) {
    case "attach_organization": return [{ handle: request.data_network_handle, role: "data_network" }];
    case "create_world_service": return [{ handle: request.data_network_handle, role: "data_network" }, { handle: request.evidence_volume_handle, role: "evidence_volume" }, { handle: request.secret_bindings_handle, role: "secret_bindings" }, { handle: request.world_artifact_handle, role: "world_artifact" }];
    case "start_world_service": case "stop_world_service": return [{ handle: request.world_service_handle, role: "world_service" }];
    case "detach_organization": return [{ handle: request.data_network_handle, role: "data_network" }, { handle: request.organization_attachment_handle, role: "organization_attachment" }];
    case "export_evidence_volume": return [{ handle: request.evidence_volume_handle, role: "evidence_volume" }];
    case "revoke_secret_bindings": return [{ handle: request.secret_bindings_handle, role: "secret_bindings" }];
    case "cleanup_run": return [request.evidence_volume_handle && { handle: request.evidence_volume_handle, role: "evidence_volume" }, request.organization_attachment_handle && { handle: request.organization_attachment_handle, role: "organization_attachment" }, request.secret_bindings_handle && { handle: request.secret_bindings_handle, role: "secret_bindings" }, request.world_service_handle && { handle: request.world_service_handle, role: "world_service" }].filter((item): item is { handle: OpaqueTargetHandle; role: ResultRole } => Boolean(item));
    default: return [];
  }
};

const receiptFrom = (claim: StoredClaim): TargetResourceReceipt => {
  if (claim.state !== "completed" || typeof claim.receipt_bytes !== "string") return fail();
  let receipt: TargetResourceReceipt;
  try { receipt = parseTargetResourceReceipt(JSON.parse(claim.receipt_bytes)); } catch { return fail(); }
  if (createCanonicalTargetReceiptBytes(receipt) !== claim.receipt_bytes || receipt.receipt_digest !== createTargetReceiptDigest(receipt)) fail();
  return receipt;
};

const parseStore = (text: string): PrivateStore => {
  if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) fail();
  try {
    const raw: unknown = JSON.parse(text); if (!isRecord(raw)) fail(); const record = raw as Record<string, unknown>;
    if (!exactKeys(record, ["adapter", "claims", "journal", "version"]) || record.version !== PRIVATE_VERSION || !isRecord(record.adapter) || !Array.isArray(record.claims) || record.claims.length > 128) fail();
    const adapter = record.adapter as Record<string, unknown>; const claimsRaw = record.claims as unknown[];
    if (!exactKeys(adapter, ["context"]) || typeof adapter.context !== "string" || !CONTEXT_PATTERN.test(adapter.context)) fail();
    const context = adapter.context as string; const journal = parseTargetResourceJournal(record.journal); const claims = claimsRaw.map((value: unknown, index: number): StoredClaim => {
      if (!isRecord(value)) return fail(); const claim = value as Record<string, unknown>;
      if (!exactKeys(claim, Object.prototype.hasOwnProperty.call(claim, "receipt_bytes") ? ["idempotency_key", "operation", "operation_handle", "receipt_bytes", "request_digest", "state"] : ["idempotency_key", "operation", "operation_handle", "request_digest", "state"]) || typeof claim.idempotency_key !== "string" || !/^idem_[a-z0-9]{16,64}$/u.test(claim.idempotency_key) || typeof claim.operation !== "string" || !digest(claim.request_digest) || (claim.state !== "pending" && claim.state !== "completed") || (claim.receipt_bytes !== undefined && typeof claim.receipt_bytes !== "string")) return fail();
      const entry = journal.entries[index]; if (!entry || entry.operation !== claim.operation || entry.operation_handle !== claim.operation_handle || entry.request_digest !== claim.request_digest || entry.state !== claim.state) return fail();
      return { idempotency_key: claim.idempotency_key, operation: entry.operation, operation_handle: parseOpaqueTargetHandle(claim.operation_handle), ...(typeof claim.receipt_bytes === "string" ? { receipt_bytes: claim.receipt_bytes } : {}), request_digest: claim.request_digest, state: claim.state };
    });
    if (claims.length !== journal.entries.length || new Set(claims.map((claim) => claim.idempotency_key)).size !== claims.length || new Set(claims.map((claim) => claim.operation_handle)).size !== claims.length) fail();
    let completed = 0; let pending = 0;
    for (const [index, claim] of claims.entries()) {
      const entry = journal.entries[index];
      if (claim.state === "pending") { pending += 1; if (claim.receipt_bytes !== undefined || entry.receipt_digest !== createPendingReceiptDigest(claim.operation_handle, claim.request_digest) || index !== claims.length - 1) fail(); continue; }
      completed += 1; const receipt = receiptFrom(claim);
      if (entry.receipt_digest !== receipt.receipt_digest || receipt.operation !== claim.operation || receipt.operation_handle !== claim.operation_handle || receipt.request_digest !== claim.request_digest || receipt.run_id !== journal.run_id || !same(receipt.selected_target, journal.selected_target) || receipt.descriptor_digest !== journal.descriptor_digest || receipt.resulting_revision !== index + 1) fail();
    }
    if (pending > 1 || journal.revision !== completed) fail();
    return { adapter: { context }, claims, journal, version: PRIVATE_VERSION };
  } catch { return fail(); }
};

const writeStore = async (filePath: string, store: PrivateStore, createOnly = false): Promise<void> => {
  const content = JSON.stringify(store); if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) fail(); parseStore(content);
  const temporaryPath = `${filePath}.store.${process.pid}.${randomUUID()}.tmp`; let handle;
  try {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
    if (createOnly && await checkedRead(filePath) !== null) fail();
    await rename(temporaryPath, filePath); await filesystem.syncDirectory(directoryOf(filePath));
  } catch { if (handle) await handle.close().catch(() => undefined); await unlink(temporaryPath).catch(() => undefined); return fail(); }
};

type LockState = "live" | "missing" | "stale";
const inspectLock = async (lockPath: string): Promise<LockState> => {
  let stats;
  try { stats = await lstat(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; return fail(); }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 32) fail();
  if (stats.size === 0) return "stale";
  let handle; try { handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; return fail(); }
  let text: string; try { text = await handle.readFile({ encoding: "utf8" }); } catch { return fail(); } finally { await handle.close().catch(() => undefined); }
  if (!/^[1-9][0-9]{0,9}\n$/u.test(text)) fail();
  try { process.kill(Number(text.slice(0, -1)), 0); return "live"; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "live"; }
};

const placeLock = async (lockPath: string): Promise<boolean> => {
  const temporaryPath = `${lockPath}.tmp.${process.pid}.${randomUUID()}`; let handle;
  try {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
    try { await link(temporaryPath, lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    await filesystem.syncDirectory(directoryOf(lockPath)); return true;
  } catch { return fail(); } finally { if (handle) await handle.close().catch(() => undefined); await unlink(temporaryPath).catch(() => undefined); }
};
const releaseLock = async (lockPath: string): Promise<void> => { await unlink(lockPath).catch(fail); await filesystem.syncDirectory(directoryOf(lockPath)).catch(fail); };
const pause = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

const recoverStaleLock = async (lockPath: string): Promise<void> => {
  const recoveryPath = `${lockPath}.recover`;
  if (!await placeLock(recoveryPath)) { await pause(); return; }
  try { if (await inspectLock(lockPath) === "stale") { await unlink(lockPath).catch(fail); await filesystem.syncDirectory(directoryOf(lockPath)); } }
  finally { await releaseLock(recoveryPath); }
};
const withLock = async <T>(filePath: string, action: () => Promise<T>): Promise<T> => {
  const lockPath = `${filePath}.lock`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await placeLock(lockPath)) { try { return await action(); } catch (error) { if (error instanceof SpawnfileError) throw error; return fail(); } finally { await releaseLock(lockPath); } }
    if (await inspectLock(lockPath) === "stale") await recoverStaleLock(lockPath); else await pause();
  }
  return fail();
};

const mutation = (request: TargetResourceRequest): Exclude<TargetResourceRequest, { operation: "select_target" }> => { if (request.operation === "select_target") fail(); return request as Exclude<TargetResourceRequest, { operation: "select_target" }>; };
const journalMatches = (store: PrivateStore, identity: TargetDigest, input: { context: string; descriptor: TargetDigest; runId: string; selected: SelectedTargetReceipt }): void => {
  const selectedTarget = { fingerprint: input.selected.fingerprint, handle: input.selected.handle };
  if (createTargetJournalIdentity({ context: input.context, descriptor_digest: input.descriptor, run_id: input.runId, selected_target: input.selected }) !== identity || store.adapter.context !== input.context || store.journal.descriptor_digest !== input.descriptor || store.journal.run_id !== input.runId || !same(store.journal.selected_target, selectedTarget)) fail();
};
const priorHandlesMatch = (store: PrivateStore, request: TargetResourceRequest): boolean => {
  const provenance = new Map<OpaqueTargetHandle, ResultRole[]>();
  for (const claim of store.claims) if (claim.state === "completed") { const role = roleForOperation[claim.operation]; const result = receiptFrom(claim).result_handle; if (role && result !== null) provenance.set(result, [...(provenance.get(result) ?? []), role]); }
  return requiredHandles(request).every(({ handle, role }) => { const roles = provenance.get(handle); return roles?.length === 1 && roles[0] === role; });
};

class TargetJournalStoreImpl implements TargetJournalStore {
  readonly #filePath: string;
  readonly #identity: TargetDigest;
  readonly #input: { context: string; descriptor: TargetDigest; runId: string; selected: SelectedTargetReceipt };
  public constructor(filePath: string, identity: TargetDigest, input: { context: string; descriptor: TargetDigest; runId: string; selected: SelectedTargetReceipt }) { this.#filePath = filePath; this.#identity = identity; this.#input = input; }
  public async read(): Promise<TargetResourceJournal> { const store = parseStore((await checkedRead(this.#filePath)) ?? fail()); journalMatches(store, this.#identity, this.#input); return store.journal; }
  public async lookup(raw: unknown): Promise<TargetOperationLookup> {
    let request: TargetMutationRequest;
    try { request = mutation(parseTargetResourceRequest(raw)); } catch { return fail(); }
    const requestDigest = createTargetRequestDigest(request);
    const store = parseStore((await checkedRead(this.#filePath)) ?? fail());
    journalMatches(store, this.#identity, this.#input);
    if (request.run_id !== store.journal.run_id
      || request.descriptor_digest !== store.journal.descriptor_digest
      || !same(request.selected_target, store.journal.selected_target)) return fail();
    const base = {
      idempotency_key: request.idempotency_key,
      operation: request.operation,
      request_digest: requestDigest,
      version: TARGET_OPERATION_LOOKUP_VERSION
    };
    const found = store.claims.find((claim) =>
      claim.idempotency_key === request.idempotency_key);
    if (!found) return parseTargetOperationLookup({ ...base, status: "not_applied" });
    if (found.operation !== request.operation
      || found.request_digest !== requestDigest) return fail();
    if (found.state === "pending") return parseTargetOperationLookup({
      ...base, operation_handle: found.operation_handle, status: "pending"
    });
    const receipt = receiptFrom(found);
    if (receipt.resulting_revision !== request.expected_revision + 1) return fail();
    return parseTargetOperationLookup({
      ...base,
      operation_handle: found.operation_handle,
      receipt,
      status: "completed"
    });
  }
  public async resolveCompletedReceipt(claim: TargetJournalClaim): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string } | null> {
    try { parseOpaqueTargetHandle(claim.operationHandle); createPendingReceiptDigest(claim.operationHandle, claim.requestDigest); } catch { return fail(); }
    const store = parseStore((await checkedRead(this.#filePath)) ?? fail()); journalMatches(store, this.#identity, this.#input);
    const found = store.claims.find((item) => item.operation_handle === claim.operationHandle && item.request_digest === claim.requestDigest);
    return !found || found.state !== "completed" ? null : { receipt: receiptFrom(found), receiptBytes: found.receipt_bytes! };
  }
  /** A separate lock deliberately permits the journal's short reserve/complete locks to nest. */
  public async withLifecycleLease<Result>(action: () => Promise<Result>): Promise<Result> {
    return withLock(`${this.#filePath}.lifecycle`, action);
  }
  public async reserve(raw: unknown): Promise<TargetJournalReservation> {
    let request: Exclude<TargetResourceRequest, { operation: "select_target" }>; try { request = mutation(parseTargetResourceRequest(raw)); } catch { return fail(); }
    const requestDigest = createTargetRequestDigest(request);
    return withLock(this.#filePath, async () => {
      const store = parseStore((await checkedRead(this.#filePath)) ?? fail()); journalMatches(store, this.#identity, this.#input);
      if (request.operation === "recover_operation") return this.recoverParsed(store, request);
      if (request.run_id !== store.journal.run_id || !same(request.selected_target, store.journal.selected_target) || request.descriptor_digest !== store.journal.descriptor_digest) fail();
      const found = store.claims.find((claim) => claim.idempotency_key === request.idempotency_key);
      if (found) { if (found.request_digest !== requestDigest) fail(); const claim = { operationHandle: found.operation_handle, requestDigest: found.request_digest }; return found.state === "pending" ? { kind: "pending", claim } : { kind: "replay", receipt: receiptFrom(found), receiptBytes: found.receipt_bytes! }; }
      if (request.expected_revision !== store.journal.revision || store.claims.some((claim) => claim.state === "pending") || store.claims.length >= 128 || !priorHandlesMatch(store, request)) fail();
      const operationHandle = createTargetOperationHandle(this.#identity, request); const claim: StoredClaim = { idempotency_key: request.idempotency_key, operation: request.operation, operation_handle: operationHandle, request_digest: requestDigest, state: "pending" };
      const entry = { operation: request.operation, operation_handle: operationHandle, receipt_digest: createPendingReceiptDigest(operationHandle, requestDigest), request_digest: requestDigest, state: "pending" as const };
      await writeStore(this.#filePath, { ...store, claims: [...store.claims, claim], journal: { ...store.journal, entries: [...store.journal.entries, entry] } }); return { kind: "owner", claim: { operationHandle, requestDigest } };
    });
  }
  private recoverParsed(store: PrivateStore, request: Extract<TargetResourceRequest, { operation: "recover_operation" }>): TargetJournalReservation {
    if (request.run_id !== store.journal.run_id || !same(request.selected_target, store.journal.selected_target) || request.descriptor_digest !== store.journal.descriptor_digest || request.expected_revision !== store.journal.revision) fail();
    const found = store.claims.find((claim) => claim.operation_handle === request.operation_handle); if (!found || found.state !== "pending") return fail(); return { kind: "pending", claim: { operationHandle: found.operation_handle, requestDigest: found.request_digest } };
  }
  public async complete(claim: TargetJournalClaim, raw: unknown): Promise<{ readonly receipt: TargetResourceReceipt; readonly receiptBytes: string }> {
    try { parseOpaqueTargetHandle(claim.operationHandle); createPendingReceiptDigest(claim.operationHandle, claim.requestDigest); } catch { return fail(); }
    let receipt: TargetResourceReceipt; let receiptBytes: string; try { receipt = parseTargetResourceReceipt(raw); receiptBytes = createCanonicalTargetReceiptBytes(receipt); } catch { return fail(); }
    return withLock(this.#filePath, async () => {
      const store = parseStore((await checkedRead(this.#filePath)) ?? fail()); journalMatches(store, this.#identity, this.#input);
      const found = store.claims.find((item) => item.operation_handle === claim.operationHandle && item.request_digest === claim.requestDigest); if (!found) return fail();
      if (found.state === "completed") { if (found.receipt_bytes !== receiptBytes) fail(); return { receipt: receiptFrom(found), receiptBytes }; }
      const resultingRevision = receipt.resulting_revision; if (resultingRevision === null || resultingRevision !== store.journal.revision + 1 || receipt.operation !== found.operation || receipt.operation_handle !== found.operation_handle || receipt.request_digest !== found.request_digest || receipt.receipt_digest !== createTargetReceiptDigest(receipt) || receipt.run_id !== store.journal.run_id || !same(receipt.selected_target, store.journal.selected_target) || receipt.descriptor_digest !== store.journal.descriptor_digest) return fail();
      const claims = store.claims.map((item) => item === found ? { ...item, receipt_bytes: receiptBytes, state: "completed" as const } : item); const entries = store.journal.entries.map((item) => item.operation_handle === found.operation_handle ? { ...item, receipt_digest: receipt.receipt_digest, state: "completed" as const } : item);
      await writeStore(this.#filePath, { ...store, claims, journal: { ...store.journal, entries, revision: resultingRevision } }); return { receipt, receiptBytes };
    });
  }
}

export const initializeTargetJournal = async (options: InitializeTargetJournalOptions): Promise<TargetJournalStore> => {
  try {
    const selected = parseSelectedTargetReceipt(options.selectedTarget); if (typeof options.context !== "string" || !digest(options.descriptorDigest)) fail();
    const context = options.context as string; const descriptor = options.descriptorDigest as TargetDigest; if (!CONTEXT_PATTERN.test(context)) fail(); const runId = parseRunId(options.runId); const root = await prepareTargetJournalRoot(options.root ?? resolveTargetJournalRoot());
    const input = { context, descriptor, runId, selected }; const identity = createTargetJournalIdentity({ context, descriptor_digest: descriptor, run_id: runId, selected_target: selected }); const filePath = path.join(root, `${identity.slice("sha256:".length)}.json`); const session = new TargetJournalStoreImpl(filePath, identity, input);
    await withLock(filePath, async () => { const existing = await checkedRead(filePath); if (existing !== null) { journalMatches(parseStore(existing), identity, input); return; } const journal = parseTargetResourceJournal({ descriptor_digest: descriptor, entries: [], revision: 0, run_id: runId, selected_target: { fingerprint: selected.fingerprint, handle: selected.handle }, version: TARGET_JOURNAL_VERSION }); await writeStore(filePath, { adapter: { context }, claims: [], journal, version: PRIVATE_VERSION }, true); });
    return session;
  } catch { return fail(); }
};

const openExistingTargetJournalStore = async (
  options: InitializeTargetJournalOptions
): Promise<TargetJournalStoreImpl> => {
  try {
    const selected = parseSelectedTargetReceipt(options.selectedTarget);
    if (typeof options.context !== "string" || !digest(options.descriptorDigest)) fail();
    const context = options.context as string;
    const descriptor = options.descriptorDigest as TargetDigest;
    if (!CONTEXT_PATTERN.test(context)) fail();
    const runId = parseRunId(options.runId);
    const root = await findExistingTargetJournalRoot(
      options.root ?? resolveTargetJournalRoot()
    );
    if (root === null) return fail();
    const input = { context, descriptor, runId, selected };
    const identity = createTargetJournalIdentity({ context, descriptor_digest: descriptor, run_id: runId, selected_target: selected });
    const filePath = path.join(root, `${identity.slice("sha256:".length)}.json`);
    const content = await checkedRead(filePath);
    if (content === null) return fail();
    journalMatches(parseStore(content), identity, input);
    return new TargetJournalStoreImpl(filePath, identity, input);
  } catch { return fail(); }
};

/** Internal full authority for target-owned lifecycle recovery. Not barrel-exported. */
export const openExistingTargetJournalAuthority = (
  options: InitializeTargetJournalOptions
): Promise<TargetJournalStore> => openExistingTargetJournalStore(options);

/** Public read-only facade over one already-existing journal. */
export const openExistingTargetJournal = async (
  options: InitializeTargetJournalOptions
): Promise<TargetJournalLookupStore> => {
  const store = await openExistingTargetJournalStore(options);
  return Object.freeze({ lookup: (raw: unknown) => store.lookup(raw) });
};

/** Looks up one exact original mutation without creating, locking, or modifying owner state. */
export const lookupTargetOperation = async (
  options: LookupTargetOperationOptions
): Promise<TargetOperationLookup> => {
  try {
    const request = mutation(parseTargetResourceRequest(options.request));
    if (typeof options.context !== "string" || !CONTEXT_PATTERN.test(options.context)) fail();
    const context = options.context as string;
    const requestDigest = createTargetRequestDigest(request);
    const base = {
      idempotency_key: request.idempotency_key,
      operation: request.operation,
      request_digest: requestDigest,
      version: TARGET_OPERATION_LOOKUP_VERSION
    };
    const root = await findExistingTargetJournalRoot(
      options.root ?? resolveTargetJournalRoot()
    );
    if (root === null) return parseTargetOperationLookup({
      ...base, status: "not_applied"
    });
    const selected = parseSelectedTargetReceipt({
      ...request.selected_target, version: SELECTED_TARGET_VERSION
    });
    const identity = createTargetJournalIdentity({
      context,
      descriptor_digest: request.descriptor_digest,
      run_id: request.run_id,
      selected_target: selected
    });
    if (await checkedRead(path.join(
      root, `${identity.slice("sha256:".length)}.json`
    )) === null) {
      return parseTargetOperationLookup({ ...base, status: "not_applied" });
    }
    const journal = await openExistingTargetJournal({
      context,
      descriptorDigest: request.descriptor_digest,
      root,
      runId: request.run_id,
      selectedTarget: selected
    });
    return journal.lookup(request);
  } catch { return fail(); }
};
export const openTargetJournal = initializeTargetJournal;
