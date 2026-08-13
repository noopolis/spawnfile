import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { assertOrdinaryJsonGraph, parseOpaqueTargetHandle, parseRunId, parseTargetResourceExportIndex, type OpaqueTargetHandle, type TargetResourceExportIndex } from "./contracts.js";
import { EVIDENCE_EXPORT_ERROR, EVIDENCE_EXPORT_HELPER_CONTRACT, assertExportRun, createEvidenceExportHandle, createEvidenceExportHelper, evidenceReceiptLabels, parseEvidenceVolumeAuthority, type EvidenceExportHelper, type EvidenceVolumeAuthority } from "./evidenceExportProvider.js";
import { destinationKey, MAX_BYTES, publishImmutable } from "./evidenceExportStorePublication.js";

const VERSION = "spawnfile.target-evidence-export.private.v1" as const;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
export interface EvidenceExportAdmission {
  readonly evidence_volume: EvidenceVolumeAuthority;
  readonly helper: EvidenceExportHelper;
  readonly helper_contract: typeof EVIDENCE_EXPORT_HELPER_CONTRACT;
  readonly descriptor_digest: string;
  readonly operation_handle: OpaqueTargetHandle;
  readonly request_digest: string;
  readonly run_id: string;
  readonly selected_target: { readonly fingerprint: string; readonly handle: OpaqueTargetHandle };
  readonly version: typeof VERSION;
}
export interface EvidenceExportAuthorityStore {
  bindAdmission(raw: EvidenceExportAdmission): Promise<void>;
  bindDestination(admission: EvidenceExportAdmission, destination: string): Promise<void>;
  bindIndex(admission: EvidenceExportAdmission, index: TargetResourceExportIndex): Promise<string>;
  loadAdmission(operationHandle: OpaqueTargetHandle): Promise<EvidenceExportAdmission>;
  loadIndex(admission: EvidenceExportAdmission): Promise<{ readonly index: TargetResourceExportIndex; readonly bytes: string } | null>;
  requireDestination(admission: EvidenceExportAdmission, destination: string): Promise<void>;
  /**
   * A private, short-lived owner lease for one export operation.  This is not a
   * second journal: it has no result state and exists solely to keep separate
   * callers from performing the same Docker/export mutation at once.
   * `null` means a live exact owner exists; callers must return incomplete and
   * retry rather than wait or steal it.
   */
  claimExport(admission: EvidenceExportAdmission): Promise<EvidenceExportClaim | null>;
  releaseExport(admission: EvidenceExportAdmission, claim: EvidenceExportClaim): Promise<void>;
  /** Recovery-only: clear one proven-dead exact claim, but never claim it. */
  clearStaleExportClaim(admission: EvidenceExportAdmission): Promise<boolean>;
}
export interface EvidenceExportClaim { readonly token: string; }
export interface EvidenceExportAuthorityStoreOptions {
  /** Test seam; production uses signal 0 and treats permission errors as live. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Test seam; production tokens are 256-bit random values. */
  readonly createToken?: () => string;
  /** Test-only crash seam for immutable publication: after final hard link and before temp unlink. */
  readonly afterImmutableFinalLinkBeforeTempUnlink?: () => Promise<void>;
  /** Test-only seam after transient immutable read in converged and recovery states. */
  readonly afterImmutableTransientRead?: () => Promise<void>;
  /** Test-only crash seams for the keyed-destination authority publication. */
  readonly beforeDestinationKeyLink?: () => Promise<void>;
  readonly afterDestinationKeyInitialFinalAbsent?: () => Promise<void>;
  readonly afterDestinationKeyLinkBeforePendingUnlink?: () => Promise<void>;
  readonly afterDestinationKeyPendingLinkBeforeTempUnlink?: () => Promise<void>;
  readonly afterDestinationKeyPendingLstatBeforeOpen?: () => Promise<void>;
  readonly afterDestinationKeyPendingLink?: () => Promise<void>;
  readonly afterDestinationKeyRecovered?: () => Promise<void>;
  /** Test-only seam after observing a final destination key snapshot. */
  readonly afterDestinationKeyFinalSnapshot?: () => Promise<void>;
  /** Test-only deterministic claim-recovery interleaving seams. */
  readonly afterStaleClaimObserved?: () => Promise<void>;
  readonly afterRecoveryTombstoneLinked?: () => Promise<void>;
  readonly afterClaimPendingCreated?: () => Promise<void>;
  readonly afterReleaseClaimObserved?: () => Promise<void>;
  readonly onReleaseRecoveryTombstone?: () => Promise<void>;
}
const fail = (): never => { throw new Error(EVIDENCE_EXPORT_ERROR); };
const canonical = (value: unknown): string => {
  assertOrdinaryJsonGraph(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const name = (domain: string, value: string): string => createHash("sha256").update(`spawnfile.target-evidence-export.${domain}.v1\0`).update(value).digest("hex");
const admission = (raw: unknown): EvidenceExportAdmission => {
  try {
    assertOrdinaryJsonGraph(raw); if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
    const value = raw as Record<string, unknown>; if (Object.keys(value).sort().join("\0") !== "descriptor_digest\0evidence_volume\0helper\0helper_contract\0operation_handle\0request_digest\0run_id\0selected_target\0version" || value.version !== VERSION || value.helper_contract !== EVIDENCE_EXPORT_HELPER_CONTRACT || typeof value.request_digest !== "string" || !DIGEST.test(value.request_digest) || typeof value.descriptor_digest !== "string" || !DIGEST.test(value.descriptor_digest) || typeof value.run_id !== "string" || !value.selected_target || typeof value.selected_target !== "object" || Array.isArray(value.selected_target)) return fail();
    const target = value.selected_target as Record<string, unknown>; if (Object.keys(target).sort().join("\0") !== "fingerprint\0handle" || typeof target.fingerprint !== "string" || !/^sha256:[a-f0-9]{32}$/u.test(target.fingerprint)) return fail();
    const evidenceVolume = parseEvidenceVolumeAuthority(value.evidence_volume); const rawHelper = value.helper as Record<string, unknown>; if (!rawHelper || Object.keys(rawHelper).sort().join("\0") !== "artifactManifestDigest\0image_digest\0image_reference\0result_handle") return fail(); const helper = createEvidenceExportHelper({ artifactManifestDigest: rawHelper.artifactManifestDigest, imageDigest: rawHelper.image_digest, imageReference: rawHelper.image_reference, resultHandle: rawHelper.result_handle }); const runId = parseRunId(value.run_id); const selectedTargetHandle = parseOpaqueTargetHandle(target.handle); assertExportRun(evidenceVolume, { runId, selectedTargetHandle });
    return Object.freeze({ descriptor_digest: value.descriptor_digest, evidence_volume: evidenceVolume, helper, helper_contract: EVIDENCE_EXPORT_HELPER_CONTRACT, operation_handle: parseOpaqueTargetHandle(value.operation_handle), request_digest: value.request_digest, run_id: runId, selected_target: Object.freeze({ fingerprint: target.fingerprint, handle: selectedTargetHandle }), version: VERSION });
  } catch { return fail(); }
};
const checkedRoot = async (raw: unknown): Promise<string> => {
  if (typeof raw !== "string" || raw.length < 1 || Buffer.byteLength(raw, "utf8") > 4_096) return fail();
  const root = path.resolve(raw); const parsed = path.parse(root);
  /* A filesystem root cannot be made into a private per-run authority boundary. */
  if (root === parsed.root) return fail();
  let current = parsed.root; let createdRoot = false;
  for (const piece of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece); let info; let created = false;
    try { info = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
      try { await mkdir(current, { mode: 0o700 }); created = true; }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") return fail(); }
      info = await lstat(current).catch(fail);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return fail();
    if (current === root) {
      createdRoot = created;
      if (!createdRoot && (info.uid !== (process.getuid?.() ?? -1) || (info.mode & 0o777) !== 0o700)) return fail();
    }
  }
  if (createdRoot) await chmod(root, 0o700).catch(fail);
  const final = await lstat(root).catch(fail);
  if (!final.isDirectory() || final.isSymbolicLink() || final.uid !== (process.getuid?.() ?? -1) || (final.mode & 0o777) !== 0o700) return fail();
  return root;
};
const read = async (file: string, links: readonly number[] = [1]): Promise<string | null> => {
  let info; try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
  if (!info.isFile() || info.isSymbolicLink() || !links.includes(info.nlink) || info.uid !== (process.getuid?.() ?? -1) || info.size > MAX_BYTES || (info.mode & 0o777) !== 0o600) return fail();
  let handle; try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return fail(); }
  try { const current = await handle.stat(); if (!current.isFile() || !links.includes(current.nlink) || current.uid !== (process.getuid?.() ?? -1) || current.size > MAX_BYTES || (current.mode & 0o777) !== 0o600) return fail(); return await handle.readFile({ encoding: "utf8" }); } catch { return fail(); } finally { await handle.close().catch(() => undefined); }
};
const sync = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const destinationCommitment = (key: Buffer, value: EvidenceExportAdmission, destination: string): string => createHmac("sha256", key).update(`${value.operation_handle}\0${value.request_digest}\0${value.run_id}\0${value.selected_target.handle}\0${value.descriptor_digest}\0${value.evidence_volume.resultHandle}\0${destination}`, "utf8").digest("hex");
const claimAuthority = (value: EvidenceExportAdmission): string => createHash("sha256").update(`spawnfile.target-evidence-export.claim.v1\0${canonical(value)}`, "utf8").digest("hex");
const claimFile = (root: string, value: EvidenceExportAdmission): string => path.join(root, `${name("claim", value.operation_handle)}.claim.json`);
const claimPendingFile = (file: string): string => `${file}.pending`;
const claimRecoveryFile = (file: string): string => `${file}.recovery`;
interface ClaimRecord { readonly authority: string; readonly generation: string; readonly owner_pid: number; readonly token: string; readonly version: typeof VERSION; }
const claimRecord = (raw: unknown): ClaimRecord => {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(); const value = raw as Record<string, unknown>;
    const ownerPid = value.owner_pid;
    if (Object.keys(value).sort().join("\0") !== "authority\0generation\0owner_pid\0token\0version" || value.version !== VERSION || typeof value.authority !== "string" || !/^[a-f0-9]{64}$/u.test(value.authority) || typeof value.generation !== "string" || !/^[a-f0-9]{64}$/u.test(value.generation) || typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid < 1 || typeof value.token !== "string" || !/^[a-f0-9]{64}$/u.test(value.token)) return fail();
    return Object.freeze({ authority: value.authority, generation: value.generation, owner_pid: ownerPid, token: value.token, version: VERSION });
  } catch { return fail(); }
};
const claimBytes = (value: ClaimRecord): string => canonical(value);
const liveProcess = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
const parsedClaim = (bytes: string | null): ClaimRecord | null => {
  if (bytes === null) return null;
  try { const value = claimRecord(JSON.parse(bytes)); if (claimBytes(value) !== bytes) return fail(); return value; } catch { return fail(); }
};
interface ClaimSnapshot { readonly bytes: string; readonly dev: number; readonly ino: number; readonly nlink: number; readonly path: string; readonly record: ClaimRecord; }
const snapshotClaim = async (file: string): Promise<ClaimSnapshot | null> => {
  let first; try { first = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
  if (!first.isFile() || first.isSymbolicLink() || ![1, 2, 3].includes(first.nlink) || first.uid !== (process.getuid?.() ?? -1) || first.size > MAX_BYTES || (first.mode & 0o777) !== 0o600) return fail();
  let handle; try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || ![1, 2, 3].includes(info.nlink) || info.uid !== (process.getuid?.() ?? -1) || info.size > MAX_BYTES || (info.mode & 0o777) !== 0o600 || info.dev !== first.dev || info.ino !== first.ino) return fail();
    const bytes = await handle.readFile({ encoding: "utf8" }); const record = parsedClaim(bytes); if (record === null) return fail();
    return Object.freeze({ bytes, dev: info.dev, ino: info.ino, nlink: info.nlink, path: file, record });
  } catch { return fail(); } finally { await handle.close().catch(() => undefined); }
};
const sameClaimGeneration = (left: ClaimSnapshot, right: ClaimSnapshot): boolean => left.dev === right.dev && left.ino === right.ino && left.bytes === right.bytes && left.record.token === right.record.token;
interface ClaimState { readonly final: ClaimSnapshot | null; readonly pending: ClaimSnapshot | null; readonly pendingOnly: boolean; readonly record: ClaimRecord; readonly target: ClaimSnapshot; }
const claimState = async (file: string): Promise<ClaimState | null> => {
  const final = await snapshotClaim(file); const pending = await snapshotClaim(claimPendingFile(file));
  if (final === null) return pending === null ? null : Object.freeze({ final, pending, pendingOnly: true, record: pending.record, target: pending });
  if (pending === null) return Object.freeze({ final, pending, pendingOnly: false, record: final.record, target: final });
  if (!sameClaimGeneration(final, pending)) return fail();
  return Object.freeze({ final, pending, pendingOnly: false, record: final.record, target: final });
};
const recoveryTombstone = async (file: string): Promise<ClaimSnapshot | null> => snapshotClaim(claimRecoveryFile(file));
const removeExactTombstone = async (file: string, snapshot: ClaimSnapshot): Promise<void> => {
  const current = await snapshotClaim(snapshot.path); if (current === null || !sameClaimGeneration(current, snapshot)) return fail();
  await unlink(snapshot.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail(); }); await sync(path.dirname(file));
};
const hasRecoveryTombstone = async (file: string): Promise<boolean> => (await recoveryTombstone(file)) !== null;
const unlinkExactClaimPath = async (root: string, snapshot: ClaimSnapshot): Promise<boolean> => {
  const current = await snapshotClaim(snapshot.path); if (current === null) return false;
  if (!sameClaimGeneration(current, snapshot)) return false;
  await unlink(snapshot.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail(); }); await sync(root); return true;
};
const writeClaimPending = async (file: string, bytes: string): Promise<ClaimSnapshot | null> => {
  const directory = path.dirname(file); const pending = claimPendingFile(file); const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`); let handle; let temporaryIdentity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await handle.chmod(0o600); await handle.writeFile(bytes, "utf8"); await handle.sync(); const info = await handle.stat(); if (!info.isFile() || info.uid !== (process.getuid?.() ?? -1) || (info.mode & 0o777) !== 0o600) return fail(); temporaryIdentity = { dev: info.dev, ino: info.ino }; await handle.close(); handle = undefined; await sync(directory);
    try { await link(temporary, pending); await sync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; return fail(); }
    const published = await snapshotClaim(pending); if (published === null || !temporaryIdentity || published.dev !== temporaryIdentity.dev || published.ino !== temporaryIdentity.ino || published.bytes !== bytes) return fail(); return published;
  } finally { if (handle) await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
};
const publishClaim = async (file: string, bytes: string, options?: EvidenceExportAuthorityStoreOptions): Promise<boolean> => {
  if (await hasRecoveryTombstone(file)) return false;
  const state = await claimState(file); if (state !== null) return false;
  const ownedPending = await writeClaimPending(file, bytes); if (ownedPending === null) return false;
  const pending = claimPendingFile(file);
  await options?.afterClaimPendingCreated?.();
  /* The pending pathname is shared election state.  A recovery or another
   * generation may have removed/replaced ours while a test/process paused;
   * never turn that pathname into a final claim unless it remains our inode. */
  const pendingAfterHook = await snapshotClaim(pending); if (pendingAfterHook === null || !sameClaimGeneration(pendingAfterHook, ownedPending)) return false;
  if (await hasRecoveryTombstone(file)) {
    /* We did not receive a claim, so abandon only our exact pending inode.
     * The tombstone remains as the recovery lock until its owner resolves it;
     * a later claimant therefore cannot enter the release/recovery window. */
    await unlinkExactClaimPath(path.dirname(file), ownedPending); return false;
  }
  const beforeFinalLink = await snapshotClaim(pending); if (beforeFinalLink === null || !sameClaimGeneration(beforeFinalLink, ownedPending)) return false;
  try { await link(pending, file); await sync(path.dirname(file)); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "EEXIST" && code !== "ENOENT") return fail(); return false; }
  /* A crash here is a valid two-link generation.  Claim/release/recovery all
   * preserve its inode identity instead of unlinking a path from a stale read. */
  if (!await unlinkExactClaimPath(path.dirname(file), beforeFinalLink)) return false;
  const final = await snapshotClaim(file); return final !== null && final.bytes === bytes;
};
class Store implements EvidenceExportAuthorityStore {
  readonly #root: string;
  readonly #options?: EvidenceExportAuthorityStoreOptions;
  public constructor(root: string, options?: EvidenceExportAuthorityStoreOptions) { this.#root = root; this.#options = options; }
  public async bindAdmission(raw: EvidenceExportAdmission): Promise<void> { const value = admission(raw); await publishImmutable(this.#root, `${name("admission", value.operation_handle)}.admission.json`, canonical(value), false, this.#options); }
  public async bindDestination(raw: EvidenceExportAdmission, destination: string): Promise<void> { const value = admission(raw); if (typeof destination !== "string") return fail(); const key = await destinationKey(this.#root, this.#options); await publishImmutable(this.#root, `${name("destination", value.operation_handle)}.destination.json`, JSON.stringify({ commitment: destinationCommitment(key, value, destination), version: VERSION }), false, this.#options); }
  public async loadAdmission(operationHandle: OpaqueTargetHandle): Promise<EvidenceExportAdmission> { const handle = parseOpaqueTargetHandle(operationHandle); const text = await read(path.join(this.#root, `${name("admission", handle)}.admission.json`)); if (text === null) return fail(); try { return admission(JSON.parse(text)); } catch { return fail(); } }
  public async bindIndex(raw: EvidenceExportAdmission, rawIndex: TargetResourceExportIndex): Promise<string> { const value = admission(raw); const index = validIndex(value, rawIndex); const bytes = canonical(index); await publishImmutable(this.#root, `${name("index", value.operation_handle)}.index.json`, bytes, false, this.#options); return bytes; }
  public async loadIndex(raw: EvidenceExportAdmission): Promise<{ readonly index: TargetResourceExportIndex; readonly bytes: string } | null> { const value = admission(raw); const bytes = await read(path.join(this.#root, `${name("index", value.operation_handle)}.index.json`)); if (bytes === null) return null; try { const index = validIndex(value, JSON.parse(bytes)); if (canonical(index) !== bytes) return fail(); return { index, bytes }; } catch { return fail(); } }
  public async requireDestination(raw: EvidenceExportAdmission, destination: string): Promise<void> { const value = admission(raw); if (typeof destination !== "string") return fail(); const key = await destinationKey(this.#root, this.#options); const bytes = await read(path.join(this.#root, `${name("destination", value.operation_handle)}.destination.json`)); if (bytes === null) return fail(); try { const parsed = JSON.parse(bytes) as Record<string, unknown>; if (Object.keys(parsed).sort().join("\0") !== "commitment\0version" || parsed.version !== VERSION || typeof parsed.commitment !== "string" || parsed.commitment !== destinationCommitment(key, value, destination)) return fail(); } catch { return fail(); } }
  public async claimExport(raw: EvidenceExportAdmission): Promise<EvidenceExportClaim | null> {
    const value = admission(raw); const authority = claimAuthority(value); const file = claimFile(this.#root, value);
    const token = this.#options?.createToken?.() ?? randomBytes(32).toString("hex"); if (!/^[a-f0-9]{64}$/u.test(token)) return fail();
    const candidate = claimBytes({ authority, generation: randomBytes(32).toString("hex"), owner_pid: process.pid, token, version: VERSION });
    if (await publishClaim(file, candidate, this.#options)) return Object.freeze({ token });
    const current = await claimState(file); if (current === null) return null;
    if (current.record.authority !== authority) return fail();
    /* A normal caller never steals, including from a dead PID.  Recovery clears
     * and returns first; a later O_EXCL claim elects exactly one new owner. */
    return null;
  }
  public async releaseExport(raw: EvidenceExportAdmission, claim: EvidenceExportClaim): Promise<void> {
    const value = admission(raw); if (!claim || typeof claim.token !== "string" || !/^[a-f0-9]{64}$/u.test(claim.token)) return fail();
    const file = claimFile(this.#root, value);
    /* Claim release uses the same generation pin as recovery.  Without it, a
     * second delayed releaser could unlink a later claimant by pathname after
     * the first release had removed this generation. */
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await claimState(file); if (current === null) return;
      if (current.record.authority !== claimAuthority(value) || current.record.token !== claim.token || current.record.owner_pid !== process.pid) return;
      await this.#options?.afterReleaseClaimObserved?.();
      const tombstone = await recoveryTombstone(file);
      if (tombstone !== null) {
        if (!sameClaimGeneration(tombstone, current.target)) return fail();
        await this.#options?.onReleaseRecoveryTombstone?.();
        await Promise.resolve();
        continue;
      }
      const recovery = claimRecoveryFile(file);
      try { await link(current.target.path, recovery); await sync(this.#root); }
      catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === "EEXIST" || code === "ENOENT") { await Promise.resolve(); continue; } return fail(); }
      const pinned = await recoveryTombstone(file); const target = await snapshotClaim(current.target.path);
      if (pinned === null || target === null || !sameClaimGeneration(pinned, current.target) || !sameClaimGeneration(target, current.target)) {
        if (pinned !== null) await removeExactTombstone(file, pinned); return;
      }
      const final = await snapshotClaim(file); const pending = await snapshotClaim(claimPendingFile(file));
      if ((final !== null && !sameClaimGeneration(final, current.target)) || (pending !== null && !sameClaimGeneration(pending, current.target)) || (final === null && pending === null)) { await removeExactTombstone(file, pinned); return; }
      for (const peer of [final, pending]) {
        if (peer !== null && !await unlinkExactClaimPath(this.#root, peer)) { await removeExactTombstone(file, pinned); return; }
      }
      await removeExactTombstone(file, pinned);
      return;
    }
    return fail();
  }
  public async clearStaleExportClaim(raw: EvidenceExportAdmission): Promise<boolean> {
    const value = admission(raw); const file = claimFile(this.#root, value);
    if (await hasRecoveryTombstone(file)) return false;
    const current = await claimState(file);
    if (current === null) return false;
    if (current.record.authority !== claimAuthority(value)) return fail();
    if ((this.#options?.isProcessAlive ?? liveProcess)(current.record.owner_pid)) return false;
    await this.#options?.afterStaleClaimObserved?.();
    const recovery = claimRecoveryFile(file);
    try { await link(current.target.path, recovery); await sync(this.#root); }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === "EEXIST" || code === "ENOENT") return false; return fail(); }
    await this.#options?.afterRecoveryTombstoneLinked?.();
    const tombstone = await recoveryTombstone(file);
    const target = await snapshotClaim(current.target.path);
    /* The hard link pins the exact inode observed above.  A delayed recovery
     * that linked a later generation cannot clear it: it can only remove its
     * own pin and report incomplete. */
    if (tombstone === null || target === null || !sameClaimGeneration(tombstone, current.target) || !sameClaimGeneration(target, current.target) || (this.#options?.isProcessAlive ?? liveProcess)(tombstone.record.owner_pid)) {
      if (tombstone !== null) await removeExactTombstone(file, tombstone); return false;
    }
    const final = await snapshotClaim(file); const pending = await snapshotClaim(claimPendingFile(file)); const pinned = await recoveryTombstone(file);
    if (pinned === null || !sameClaimGeneration(pinned, current.target) || (final !== null && !sameClaimGeneration(final, current.target)) || (pending !== null && !sameClaimGeneration(pending, current.target)) || (final === null && pending === null) || (this.#options?.isProcessAlive ?? liveProcess)(pinned.record.owner_pid)) {
      if (pinned !== null) await removeExactTombstone(file, pinned); return false;
    }
    /* Tombstone remains linked while every claim name is removed.  Therefore a
     * normal claimant cannot publish in the check/unlink window. */
    for (const peer of [final, pending]) {
      if (peer !== null && !await unlinkExactClaimPath(this.#root, peer)) { await removeExactTombstone(file, pinned); return false; }
    }
    await removeExactTombstone(file, pinned); return true;
  }
}
const validIndex = (admissionValue: EvidenceExportAdmission, raw: unknown): TargetResourceExportIndex => { const index = parseTargetResourceExportIndex(raw); if (index.state !== "exported" || index.run_id !== admissionValue.run_id || index.source.evidence_volume_handle !== admissionValue.evidence_volume.resultHandle || index.source.state !== "preserved" || index.export_handle !== createEvidenceExportHandle({ evidenceVolumeHandle: admissionValue.evidence_volume.resultHandle, operationHandle: admissionValue.operation_handle, requestDigest: admissionValue.request_digest }) || JSON.stringify(index.labels) !== JSON.stringify(evidenceReceiptLabels(admissionValue.evidence_volume))) return fail(); return index; };
export const initializeEvidenceExportAuthorityStore = async (root: unknown, options?: EvidenceExportAuthorityStoreOptions): Promise<EvidenceExportAuthorityStore> => new Store(await checkedRoot(root), options);
