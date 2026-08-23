import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import { boundedRedactedText, SpawnfileError } from "../shared/index.js";
import { parseOpaqueTargetHandle, parseRunId, parseTargetResourceRequest, type TargetResourceExportIndex, type TargetResourceReceipt, type TargetResourceRequest } from "./contracts.js";
import { selectTarget } from "./dockerTarget.js";
import { createDockerResourceSpec, executeDockerResource, isExpectedDockerResource, type DockerResourceExecutor } from "./dockerResourcesProvider.js";
import { createTargetReceiptDigest } from "./handles.js";
import { type TargetJournalClaim, type TargetJournalStore } from "./journal.js";
import { EVIDENCE_EXPORT_ERROR, EVIDENCE_EXPORT_HELPER_CONTRACT, assertExportRun, createEvidenceExportHandle, createEvidenceExportHelper, createEvidenceExportHelperSpec, evidenceDigest, evidenceReceiptLabels, executeEvidenceExport, isExpectedEvidenceExportHelper, isExpectedEvidenceExportImage, parseEvidenceExportImageInspection, parseEvidenceVolumeAuthority, type DockerEvidenceExportExecutor, type EvidenceExportHelper, type EvidenceExportHelperSpec } from "./evidenceExportProvider.js";
import { canonicalEvidenceArchive } from "./evidenceExportArchive.js";
import { type EvidenceExportAdmission, type EvidenceExportAuthorityStore, type EvidenceExportClaim } from "./evidenceExportStore.js";
import { createDockerArtifactSpec, type DockerArtifactIdentityStore } from "./dockerArtifactsProvider.js";

const CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/u;
const TEMP = /^\.spawnfile-evidence-[a-f0-9]{64}\.pending$/u;
type ExportRequest = Extract<TargetResourceRequest, { operation: "export_evidence_volume" }>;
type RecoverRequest = Extract<TargetResourceRequest, { operation: "recover_operation" }>;
type ExportContext = Pick<ExportRequest, "descriptor_digest" | "evidence_volume_handle" | "run_id" | "selected_target">;
type Result = { readonly index: TargetResourceExportIndex; readonly indexBytes: string; readonly receipt: TargetResourceReceipt; readonly receiptBytes: string };

export interface EvidenceExportOperationsOptions {
  readonly authorityStore: EvidenceExportAuthorityStore;
  readonly context: unknown;
  readonly executor: DockerResourceExecutor;
  readonly exportExecutor: DockerEvidenceExportExecutor;
  readonly helperArtifactBundle?: unknown;
  /** Spawnfile-owned local config identity. Never a public provider field. */
  readonly localHelper?: unknown;
  readonly helperArtifactManifestDigest: unknown;
  readonly helperArtifactContract: unknown;
  readonly artifactIdentityStore: DockerArtifactIdentityStore;
  readonly journal: TargetJournalStore;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: unknown;
  readonly testHooks?: {
    readonly beforeBindAdmission?: () => Promise<void> | void;
    readonly beforeBindDestination?: () => Promise<void> | void;
    readonly beforeRequireDestination?: () => Promise<void> | void;
    readonly beforeIndexLoad?: () => Promise<void> | void;
    readonly beforeArchive?: () => Promise<void> | void;
    readonly beforeIndexBind?: () => Promise<void> | void;
    readonly beforePublishTempWrite?: () => Promise<void> | void;
    readonly beforePublishTempOpen?: (temporary: string) => Promise<void> | void;
    readonly beforePublishTempSync?: () => Promise<void> | void;
    readonly beforePublishFinalLink?: () => Promise<void> | void;
    readonly beforePublishDirectorySync?: () => Promise<void> | void;
    readonly beforeJournalComplete?: () => Promise<void> | void;
  };
}
export interface EvidenceExportOperations { execute(raw: unknown, destination: unknown): Promise<Result>; recover(raw: unknown, destination: unknown): Promise<Result>; }
interface HelperArtifactBundle { readonly operationHandle: ReturnType<typeof parseOpaqueTargetHandle>; readonly requestDigest: `sha256:${string}`; readonly resultHandle: ReturnType<typeof parseOpaqueTargetHandle>; }
interface EvidenceExportTestHooks {
  readonly beforeBindAdmission?: () => Promise<void> | void;
  readonly beforeBindDestination?: () => Promise<void> | void;
  readonly beforeRequireDestination?: () => Promise<void> | void;
  readonly beforeIndexLoad?: () => Promise<void> | void;
  readonly beforeArchive?: () => Promise<void> | void;
  readonly beforeIndexBind?: () => Promise<void> | void;
  readonly beforePublishTempWrite?: () => Promise<void> | void;
  readonly beforePublishTempOpen?: (temporary: string) => Promise<void> | void;
  readonly beforePublishTempSync?: () => Promise<void> | void;
  readonly beforePublishFinalLink?: () => Promise<void> | void;
  readonly beforePublishDirectorySync?: () => Promise<void> | void;
  readonly beforeJournalComplete?: () => Promise<void> | void;
}
interface Options { readonly authorityStore: EvidenceExportAuthorityStore; readonly context: string; readonly executor: DockerResourceExecutor; readonly exportExecutor: DockerEvidenceExportExecutor; readonly helperArtifactBundle?: HelperArtifactBundle; readonly localHelper?: EvidenceExportHelper; readonly helperArtifactManifestDigest: string; readonly helperArtifactContract: typeof EVIDENCE_EXPORT_HELPER_CONTRACT; readonly artifactIdentityStore: DockerArtifactIdentityStore; readonly journal: TargetJournalStore; readonly signal?: AbortSignal; readonly timeoutMs: number; readonly testHooks?: EvidenceExportTestHooks; }
const fail = (): never => { throw new SpawnfileError("runtime_error", EVIDENCE_EXPORT_ERROR); };
const failWithCause = (error: unknown): never => {
  const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  throw new SpawnfileError("runtime_error", `${EVIDENCE_EXPORT_ERROR}: ${boundedRedactedText(summary)}`, { cause: error });
};
/** Internal control outcome: another process owns an exact pending export.
 * It deliberately has no target-receipt/schema representation; callers leave
 * the journal pending and retry after their bounded scheduling interval. */
export class EvidenceExportIncompleteError extends SpawnfileError {
  public readonly incomplete = true as const;
  public constructor() { super("runtime_error", EVIDENCE_EXPORT_ERROR); }
}
export const isEvidenceExportIncomplete = (error: unknown): error is EvidenceExportIncompleteError => error instanceof EvidenceExportIncompleteError;
const incomplete = (): never => { throw new EvidenceExportIncompleteError(); };
const hook = async (value: (() => Promise<void> | void) | undefined): Promise<void> => { if (value) await value(); };
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const options = (raw: EvidenceExportOperationsOptions): Options => {
  if (typeof raw.context !== "string" || !CONTEXT.test(raw.context) || typeof raw.executor !== "function" || typeof raw.exportExecutor !== "function" || !raw.authorityStore || typeof raw.authorityStore.bindAdmission !== "function" || typeof raw.authorityStore.bindDestination !== "function" || typeof raw.authorityStore.requireDestination !== "function" || typeof raw.authorityStore.claimExport !== "function" || typeof raw.authorityStore.releaseExport !== "function" || typeof raw.authorityStore.loadAdmission !== "function" || typeof raw.authorityStore.loadIndex !== "function" || typeof raw.authorityStore.clearStaleExportClaim !== "function" || !raw.artifactIdentityStore || typeof raw.artifactIdentityStore.resolveOperation !== "function" || !raw.journal || typeof raw.journal.resolveCompletedReceipt !== "function" || typeof raw.timeoutMs !== "undefined" && (!Number.isSafeInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 1 || (raw.timeoutMs as number) > 120_000)) return fail();
  const timeoutMs = typeof raw.timeoutMs === "number" ? raw.timeoutMs : 10_000;
  try { if (typeof raw.helperArtifactManifestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(raw.helperArtifactManifestDigest) || raw.helperArtifactContract !== EVIDENCE_EXPORT_HELPER_CONTRACT) return fail(); const source = raw.localHelper as Record<string, unknown> | undefined; const localHelper = source === undefined ? undefined : createEvidenceExportHelper({ artifactManifestDigest: source.artifactManifestDigest, imageDigest: source.image_digest, imageReference: source.image_reference, resultHandle: source.result_handle }); if (localHelper) { if (raw.helperArtifactBundle !== undefined || localHelper.artifactManifestDigest !== raw.helperArtifactManifestDigest) return fail(); return { authorityStore: raw.authorityStore, context: raw.context, executor: raw.executor, exportExecutor: raw.exportExecutor, localHelper, helperArtifactManifestDigest: raw.helperArtifactManifestDigest, helperArtifactContract: EVIDENCE_EXPORT_HELPER_CONTRACT, artifactIdentityStore: raw.artifactIdentityStore, journal: raw.journal, signal: raw.signal, timeoutMs, testHooks: raw.testHooks }; } const rawBundle = raw.helperArtifactBundle; if (!rawBundle || typeof rawBundle !== "object" || Array.isArray(rawBundle) || Object.keys(rawBundle as Record<string, unknown>).sort().join("\0") !== "operation_handle\0request_digest\0result_handle") return fail(); const bundle = rawBundle as Record<string, unknown>; const helperArtifactBundle: HelperArtifactBundle = Object.freeze({ operationHandle: parseOpaqueTargetHandle(bundle.operation_handle), requestDigest: (() => { if (typeof bundle.request_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(bundle.request_digest)) return fail(); return bundle.request_digest as `sha256:${string}`; })(), resultHandle: parseOpaqueTargetHandle(bundle.result_handle) }); return { authorityStore: raw.authorityStore, context: raw.context, executor: raw.executor, exportExecutor: raw.exportExecutor, helperArtifactBundle, helperArtifactManifestDigest: raw.helperArtifactManifestDigest, helperArtifactContract: EVIDENCE_EXPORT_HELPER_CONTRACT, artifactIdentityStore: raw.artifactIdentityStore, journal: raw.journal, signal: raw.signal, timeoutMs, testHooks: raw.testHooks }; } catch { return fail(); }
};
const request = (raw: unknown): ExportRequest => { const parsed = parseTargetResourceRequest(raw); if (parsed.operation !== "export_evidence_volume") return fail(); return parsed; };
const recovery = (raw: unknown): RecoverRequest => { const parsed = parseTargetResourceRequest(raw); if (parsed.operation !== "recover_operation") return fail(); return parsed; };

const selectedContextMatches = async (value: ExportContext, input: Options): Promise<void> => {
  const selected = await selectTarget({ context: input.context, dockerCommand: "docker", execFile: input.executor, signal: input.signal, timeoutMs: input.timeoutMs });
  if (!same({ fingerprint: selected.fingerprint, handle: selected.handle }, value.selected_target)) return fail();
};
const authorityFor = async (value: ExportContext, input: Options) => {
  const journal = await input.journal.read();
  if (journal.run_id !== value.run_id || !same(journal.selected_target, value.selected_target) || journal.descriptor_digest !== value.descriptor_digest) return fail();
  const entry = journal.entries.find((item) => item.operation === "create_evidence_volume" && item.state === "completed" && createDockerResourceSpec({ kind: "evidence_volume", operationHandle: item.operation_handle, requestDigest: item.request_digest, runId: value.run_id, selectedTargetHandle: value.selected_target.handle }).resultHandle === value.evidence_volume_handle);
  if (!entry) return fail();
  const spec = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: entry.operation_handle, requestDigest: entry.request_digest, runId: value.run_id, selectedTargetHandle: value.selected_target.handle });
  const authority = parseEvidenceVolumeAuthority({ labels: spec.labels, name: spec.name, resultHandle: spec.resultHandle });
  assertExportRun(authority, { runId: value.run_id, selectedTargetHandle: value.selected_target.handle });
  return authority;
};
const inspectAuthority = async (authority: Awaited<ReturnType<typeof authorityFor>>, input: Options): Promise<void> => {
  const spec = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: parseOpaqueTargetHandle("opaque_0000000000000000"), requestDigest: `sha256:${"0".repeat(64)}`, runId: "a", selectedTargetHandle: parseOpaqueTargetHandle("opaque_0000000000000000") });
  const result = await executeDockerResource({ args: ["--context", input.context, "volume", "inspect", "--format", spec.inspectionFormat, authority.name], executor: input.executor, signal: input.signal, timeoutMs: input.timeoutMs });
  const expected = { ...spec, labels: authority.labels, name: authority.name, resultHandle: authority.resultHandle };
  if (!isExpectedDockerResource(result.stdout, expected)) return fail();
};
const helperFor = async (value: ExportContext, input: Options): Promise<EvidenceExportHelper> => {
  if (input.localHelper) return input.localHelper;
  const bundle = input.helperArtifactBundle ?? fail(); const binding = await input.artifactIdentityStore.resolveOperation(bundle.operationHandle, bundle.requestDigest); const journal = await input.journal.read();
  const completed = binding ? await input.journal.resolveCompletedReceipt({ operationHandle: binding.operationHandle, requestDigest: binding.requestDigest as `sha256:${string}` }) : null;
  if (!binding || binding.identityKind !== "oci_image_manifest" || !completed || binding.operationHandle !== bundle.operationHandle || binding.requestDigest !== bundle.requestDigest || binding.resultHandle !== bundle.resultHandle || binding.artifactManifestDigest !== input.helperArtifactManifestDigest || binding.selectedTargetHandle !== value.selected_target.handle || journal.run_id !== value.run_id || journal.descriptor_digest !== value.descriptor_digest || !same(journal.selected_target, value.selected_target) || completed.receipt.operation !== "resolve_world_artifact" || completed.receipt.result_handle !== bundle.resultHandle || completed.receipt.operation_handle !== bundle.operationHandle || completed.receipt.request_digest !== bundle.requestDigest || completed.receipt.run_id !== value.run_id || completed.receipt.descriptor_digest !== value.descriptor_digest || !same(completed.receipt.selected_target, value.selected_target)) return fail();
  const expected = createDockerArtifactSpec({ artifactManifestDigest: binding.artifactManifestDigest, imageDigest: binding.imageDigest, imageReference: binding.imageReference, operationHandle: binding.operationHandle, requestDigest: binding.requestDigest, selectedTargetHandle: binding.selectedTargetHandle }); if (expected.resultHandle !== binding.resultHandle) return fail();
  return createEvidenceExportHelper({ artifactManifestDigest: binding.artifactManifestDigest, imageDigest: binding.imageDigest, imageReference: binding.imageReference, resultHandle: binding.resultHandle });
};
const inspectHelperImage = async (helper: EvidenceExportHelper, input: Options): Promise<{ readonly labels: Readonly<Record<string, string>> }> => {
  const result = await executeDockerResource({ args: ["--context", input.context, "image", "inspect", "--format", "[{\"RepoDigests\":{{json .RepoDigests}},\"Config\":{\"Cmd\":{{json .Config.Cmd}},\"Entrypoint\":{{json .Config.Entrypoint}},\"Env\":{{json .Config.Env}},\"ExposedPorts\":{{json .Config.ExposedPorts}},\"Healthcheck\":{{json .Config.Healthcheck}},\"Labels\":{{json .Config.Labels}},\"User\":{{json .Config.User}},\"Volumes\":{{json .Config.Volumes}}}}]", helper.image_reference], executor: input.executor, signal: input.signal, timeoutMs: input.timeoutMs });
  if (!isExpectedEvidenceExportImage(result.stdout, helper)) return fail();
  return parseEvidenceExportImageInspection(result.stdout, helper);
};
const inspectHelperContainer = async (spec: EvidenceExportHelperSpec, input: Options): Promise<void> => {
  const result = await executeDockerResource({ args: ["--context", input.context, "container", "inspect", "--format", spec.inspectionFormat, spec.containerName], executor: input.executor, signal: input.signal, timeoutMs: input.timeoutMs });
  if (!isExpectedEvidenceExportHelper(result.stdout, spec)) return fail();
};
const removeHelper = async (spec: EvidenceExportHelperSpec, input: Options): Promise<void> => {
  await executeDockerResource({ args: ["--context", input.context, "container", "rm", "-f", spec.containerName], executor: input.executor, signal: input.signal, timeoutMs: input.timeoutMs });
};
const exportArchive = async (authority: Awaited<ReturnType<typeof authorityFor>>, value: ExportContext, claim: TargetJournalClaim, input: Options): Promise<ReturnType<typeof canonicalEvidenceArchive>> => {
  const helper = await helperFor(value, input); const imageInspection = await inspectHelperImage(helper, input);
  const spec = createEvidenceExportHelperSpec({ authority, helper, imageLabels: imageInspection.labels, operationHandle: claim.operationHandle, requestDigest: claim.requestDigest });
  let ownedByUs = false;
  try {
    try {
      await executeDockerResource({ args: ["--context", input.context, ...spec.createArgs], executor: input.executor, signal: input.signal, timeoutMs: input.timeoutMs });
      ownedByUs = true;
      await inspectHelperContainer(spec, input);
    } catch (error) {
      if (ownedByUs) throw error;
      await inspectHelperContainer(spec, input);
      ownedByUs = true;
    }
    const raw = await executeEvidenceExport({ args: ["--context", input.context, "container", "start", "--attach", spec.containerName], executor: input.exportExecutor, signal: input.signal, timeoutMs: input.timeoutMs });
    const rebuilt = canonicalEvidenceArchive(raw);
    return rebuilt;
  } finally {
    if (ownedByUs) {
      await removeHelper(spec, input).catch(fail);
    }
  }
};
const destinationScalar = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length < 2 || Buffer.from(raw, "utf8").toString("utf8") !== raw || Buffer.byteLength(raw, "utf8") > 4_096 || !path.isAbsolute(raw) || path.normalize(raw) !== raw || raw.split(path.sep).some((part) => part === ".." || part === ".")) return fail();
  const base = path.basename(raw);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar$/u.test(base)) return fail();
  return raw;
};
interface Destination {
  readonly directory: string;
  readonly directoryDev: number;
  readonly directoryIno: number;
  readonly existing: boolean;
  readonly final: string;
}
const sameDirectory = async (value: Destination): Promise<void> => {
  let current;
  try { current = await lstat(value.directory); } catch { return fail(); }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== value.directoryDev || current.ino !== value.directoryIno || current.uid !== (process.getuid?.() ?? -1) || (current.mode & 0o777) !== 0o700) return fail();
};
const destinationFile = async (raw: string, allowExisting = false): Promise<Destination> => {
  const directory = path.dirname(raw); const base = path.basename(raw);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar$/u.test(base)) return fail();
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); let info; try { info = await lstat(current); } catch { return fail(); } if (!info.isDirectory() || info.isSymbolicLink()) return fail(); }
  let directoryHandle;
  let directoryInfo;
  try {
    directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directoryInfo = await directoryHandle.stat();
    /* Node 22 has no descriptor-relative linkat/unlinkat API.  A private,
     * current-user directory is therefore the publication trust boundary;
     * arbitrary same-UID concurrent mutation is outside this contract. */
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== (process.getuid?.() ?? -1) || (directoryInfo.mode & 0o777) !== 0o700) return fail();
  } catch { return fail(); } finally { await directoryHandle?.close().catch(() => undefined); }
  const result = (existing: boolean): Destination => ({ directory, directoryDev: directoryInfo.dev, directoryIno: directoryInfo.ino, existing, final: raw });
  try {
    const existing = await lstat(raw);
    if (!allowExisting || !existing.isFile() || existing.isSymbolicLink() || ![1, 2].includes(existing.nlink) || existing.size > 67_108_864 || (existing.mode & 0o777) !== 0o600 || existing.uid !== (process.getuid?.() ?? -1)) return fail();
    await sameDirectory(result(true));
    return result(true);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(); }
  await sameDirectory(result(false));
  return result(false);
};
const proveDestination = async (raw: string, digest: string): Promise<void> => {
  const destination = await destinationFile(raw, true);
  let bytes: Uint8Array;
  let handle;
  try {
    handle = await open(destination.final, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 67_108_864 || (info.mode & 0o777) !== 0o600 || info.uid !== (process.getuid?.() ?? -1)) return fail();
    bytes = await handle.readFile();
  } catch { return fail(); } finally { await handle?.close().catch(() => undefined); }
  if (evidenceDigest(bytes) !== digest) return fail();
};
const syncDirectory = async (destination: Destination): Promise<void> => {
  await sameDirectory(destination);
  const handle = await open(destination.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.dev !== destination.directoryDev || info.ino !== destination.directoryIno) return fail();
    await handle.sync();
  } finally { await handle.close(); }
};
const unlinkOwnedTemp = async (destination: Destination, temporary: string, identity: { readonly dev: number; readonly ino: number }): Promise<void> => {
  await sameDirectory(destination);
  let current;
  try { current = await lstat(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; return fail(); }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) return fail();
  await unlink(temporary).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(); });
};
interface PublicationSnapshot { readonly bytes: Uint8Array; readonly dev: number; readonly ino: number; readonly nlink: number; }
const publicationSnapshot = async (file: string): Promise<PublicationSnapshot | null> => {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || ![1, 2].includes(info.nlink) || info.size > 67_108_864 || (info.mode & 0o777) !== 0o600 || info.uid !== (process.getuid?.() ?? -1)) return fail();
    return { bytes: await handle.readFile(), dev: info.dev, ino: info.ino, nlink: info.nlink };
  } catch { return fail(); } finally { await handle.close(); }
};
const pendingPath = (destination: Destination, admitted: EvidenceExportAdmission): string => {
  const name = createHash("sha256").update("spawnfile.target-evidence-export.pending.v1\0").update(admitted.operation_handle).update("\0").update(admitted.request_digest).update("\0").update(destination.final).digest("hex");
  return path.join(destination.directory, `.spawnfile-evidence-${name}.pending`);
};
const publish = async (destination: Destination, admitted: EvidenceExportAdmission, bytes: Uint8Array, testHooks: EvidenceExportTestHooks | undefined): Promise<void> => {
  const expectedDigest = evidenceDigest(bytes);
  const temporary = pendingPath(destination, admitted);
  if (!TEMP.test(path.basename(temporary))) return fail();
  if (destination.existing) {
    await sameDirectory(destination);
    const final = await publicationSnapshot(destination.final);
    if (!final || evidenceDigest(final.bytes) !== expectedDigest) return fail();
    const pending = await publicationSnapshot(temporary);
    if (pending) {
      if (pending.dev !== final.dev || pending.ino !== final.ino || pending.nlink !== 2 || final.nlink !== 2 || evidenceDigest(pending.bytes) !== expectedDigest) return fail();
      await unlinkOwnedTemp(destination, temporary, pending);
      await syncDirectory(destination);
      const settled = await publicationSnapshot(destination.final);
      if (!settled || settled.nlink !== 1 || evidenceDigest(settled.bytes) !== expectedDigest) return fail();
    } else if (final.nlink !== 1) return fail();
    return;
  }
  let handle; let ownedTemp: { readonly dev: number; readonly ino: number } | undefined;
  try {
    await hook(testHooks?.beforePublishTempWrite);
    await hook(testHooks?.beforePublishTempOpen ? () => testHooks.beforePublishTempOpen!(temporary) : undefined);
    await sameDirectory(destination);
    const recovered = await publicationSnapshot(temporary);
    if (recovered) {
      if (recovered.nlink !== 1 || evidenceDigest(recovered.bytes) !== expectedDigest) return fail();
      ownedTemp = recovered;
    } else {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const info = await handle.stat();
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.uid !== (process.getuid?.() ?? -1)) return fail();
      ownedTemp = { dev: info.dev, ino: info.ino };
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await hook(testHooks?.beforePublishTempSync);
      await handle.sync();
      await handle.close(); handle = undefined;
    }
    await hook(testHooks?.beforePublishFinalLink);
    await sameDirectory(destination);
    await link(temporary, destination.final);
    await hook(testHooks?.beforePublishDirectorySync);
    await syncDirectory(destination);
  } catch { return fail(); } finally {
    if (handle) await handle.close().catch(fail);
    if (ownedTemp) await unlinkOwnedTemp(destination, temporary, ownedTemp);
    await syncDirectory(destination);
  }
};
const receipt = async (value: ExportContext, claim: TargetJournalClaim, index: TargetResourceExportIndex, input: Options): Promise<TargetResourceReceipt> => {
  const raw = { cleanup_state: "not_requested", descriptor_digest: value.descriptor_digest, evidence_index: index, export_state: "exported", labels: index.labels.map((label) => ({ ...label })), operation: "export_evidence_volume", operation_handle: claim.operationHandle, receipt_digest: `sha256:${"0".repeat(64)}`, request_digest: claim.requestDigest, result_handle: index.export_handle, resulting_revision: (await input.journal.read()).revision + 1, run_id: value.run_id, selected_target: value.selected_target, version: "spawnfile.target-resource.receipt.v1" };
  return { ...raw, receipt_digest: createTargetReceiptDigest(raw) } as TargetResourceReceipt;
};
class Operations implements EvidenceExportOperations {
  readonly #live = new Map<string, { readonly destination: string; readonly request: ExportRequest; readonly promise: Promise<Result> }>();
  readonly #recovering = new Map<string, { readonly destination: string; readonly request: RecoverRequest; readonly promise: Promise<Result> }>();
  readonly #options: Options;
  public constructor(options: Options) { this.#options = options; }
  public execute(raw: unknown, destination: unknown): Promise<Result> {
    let value: ExportRequest; let destinationValue: string;
    try { value = request(raw); destinationValue = destinationScalar(destination); } catch { return Promise.reject(new SpawnfileError("runtime_error", EVIDENCE_EXPORT_ERROR)); }
    const running = this.#live.get(value.idempotency_key); if (running) return same(running.request, value) && running.destination === destinationValue ? running.promise : Promise.reject(new SpawnfileError("runtime_error", EVIDENCE_EXPORT_ERROR));
    const promise = this.owner(value, destinationValue).finally(() => { if (this.#live.get(value.idempotency_key)?.promise === promise) this.#live.delete(value.idempotency_key); }); this.#live.set(value.idempotency_key, { destination: destinationValue, request: value, promise }); return promise;
  }
  public recover(raw: unknown, destination: unknown): Promise<Result> {
    let value: RecoverRequest; let destinationValue: string;
    try { value = recovery(raw); destinationValue = destinationScalar(destination); } catch { return Promise.reject(new SpawnfileError("runtime_error", EVIDENCE_EXPORT_ERROR)); }
    const running = this.#recovering.get(value.operation_handle); if (running) return same(running.request, value) && running.destination === destinationValue ? running.promise : Promise.reject(new SpawnfileError("runtime_error", EVIDENCE_EXPORT_ERROR));
    const promise = this.recoverOwner(value, destinationValue).finally(() => { if (this.#recovering.get(value.operation_handle)?.promise === promise) this.#recovering.delete(value.operation_handle); }); this.#recovering.set(value.operation_handle, { destination: destinationValue, request: value, promise }); return promise;
  }
  private async publishExport(value: ExportContext, admitted: EvidenceExportAdmission, authority: Awaited<ReturnType<typeof authorityFor>>, claim: TargetJournalClaim, destination: string): Promise<Result> {
    await hook(this.#options.testHooks?.beforeIndexLoad); const existingIndex = await this.#options.authorityStore.loadIndex(admitted); const checkedDestination = await destinationFile(destination, existingIndex !== null); await hook(this.#options.testHooks?.beforeArchive); const output = await exportArchive(authority, value, claim, this.#options);
    const index: TargetResourceExportIndex = existingIndex?.index ?? { evidence_digest: evidenceDigest(output.bytes), export_handle: createEvidenceExportHandle({ evidenceVolumeHandle: value.evidence_volume_handle, operationHandle: claim.operationHandle, requestDigest: claim.requestDigest }), files: output.files.map((file) => ({ ...file })), item_count: output.files.length, labels: evidenceReceiptLabels(authority), run_id: value.run_id, source: { evidence_volume_handle: value.evidence_volume_handle, state: "preserved" }, state: "exported", version: "spawnfile.target-resource.export-index.v1" };
    if (index.evidence_digest !== evidenceDigest(output.bytes)
      || index.item_count !== output.files.length
      || !same(index.files, output.files)
      || index.source.evidence_volume_handle !== value.evidence_volume_handle
      || index.source.state !== "preserved") return fail(); const indexBytes = existingIndex?.bytes ?? (await (async () => { await hook(this.#options.testHooks?.beforeIndexBind); return this.#options.authorityStore.bindIndex(admitted, index); })()); await publish(checkedDestination, admitted, output.bytes, this.#options.testHooks); await hook(this.#options.testHooks?.beforeJournalComplete); const completed = await this.#options.journal.complete(claim, await receipt(value, claim, index, this.#options)); return { ...completed, index, indexBytes };
  }
  private async owner(value: ExportRequest, destination: string): Promise<Result> {
    try {
      const reserved = await this.#options.journal.reserve(value);
      /* A normal journal pending claim is not recovery authority.  In
       * particular, do not derive/inspect an admission, target, helper, or
       * destination from it: another owner may still be between reservation
       * and its first private write.  Recovery has its own explicit seam. */
      if (reserved.kind === "pending") return incomplete();
      /* Completed journal work is a proof-only path.  A stale owner lease from
       * a crash after completion must never make replay touch Docker or wait. */
      if (reserved.kind === "replay") {
        const completed = await this.#options.journal.resolveCompletedReceipt({ operationHandle: reserved.receipt.operation_handle, requestDigest: reserved.receipt.request_digest as `sha256:${string}` });
        if (!completed || completed.receiptBytes !== reserved.receiptBytes || !same(completed.receipt, reserved.receipt)) return fail();
        const admission = await this.#options.authorityStore.loadAdmission(reserved.receipt.operation_handle);
        const stored = await this.#options.authorityStore.loadIndex(admission);
        const durableHelper = await helperFor(value, this.#options);
        await this.#options.authorityStore.requireDestination(admission, destination);
        if (!stored
          || admission.operation_handle !== reserved.receipt.operation_handle
          || admission.request_digest !== reserved.receipt.request_digest
          || admission.run_id !== value.run_id
          || !same(admission.selected_target, value.selected_target)
          || admission.descriptor_digest !== value.descriptor_digest
          || admission.evidence_volume.resultHandle !== value.evidence_volume_handle
          || admission.helper_contract !== this.#options.helperArtifactContract
          || !same(admission.helper, durableHelper)
          || reserved.receipt.operation !== "export_evidence_volume"
          || reserved.receipt.export_state !== "exported"
          || reserved.receipt.cleanup_state !== "not_requested"
          || reserved.receipt.result_handle !== stored.index.export_handle
          || !same(reserved.receipt.evidence_index, stored.index)
          || reserved.receipt.run_id !== value.run_id
          || reserved.receipt.descriptor_digest !== value.descriptor_digest
          || !same(reserved.receipt.selected_target, value.selected_target)
          || !same(reserved.receipt.labels, stored.index.labels)) return fail();
        await proveDestination(destination, stored.index.evidence_digest);
        return { index: stored.index, indexBytes: stored.bytes, receipt: reserved.receipt, receiptBytes: reserved.receiptBytes };
      }
      /* These are read-only authority proofs.  The private operation claim is
       * acquired before image/container/export or private-state mutation. */
      const authority = await authorityFor(value, this.#options); await selectedContextMatches(value, this.#options); const helper = await helperFor(value, this.#options);
      const admitted: EvidenceExportAdmission = { descriptor_digest: value.descriptor_digest, evidence_volume: authority, helper, helper_contract: this.#options.helperArtifactContract, operation_handle: reserved.claim.operationHandle, request_digest: reserved.claim.requestDigest, run_id: value.run_id, selected_target: value.selected_target, version: "spawnfile.target-evidence-export.private.v1" };
      const exportClaim: EvidenceExportClaim | null = await this.#options.authorityStore.claimExport(admitted); if (exportClaim === null) return incomplete();
      try {
        await inspectAuthority(authority, this.#options);
        await hook(this.#options.testHooks?.beforeBindAdmission);
        await this.#options.authorityStore.bindAdmission(admitted);
        await hook(this.#options.testHooks?.beforeBindDestination);
        await this.#options.authorityStore.bindDestination(admitted, destination);
        await hook(this.#options.testHooks?.beforeRequireDestination);
        await this.#options.authorityStore.requireDestination(admitted, destination);
        return await this.publishExport(value, admitted, authority, reserved.claim, destination);
      } finally { await this.#options.authorityStore.releaseExport(admitted, exportClaim); }
    } catch (error) { if (isEvidenceExportIncomplete(error)) throw error; return failWithCause(error); }
  }
  private async recoverOwner(value: RecoverRequest, destination: string): Promise<Result> {
    try {
      const reserved = await this.#options.journal.reserve(value); if (reserved.kind !== "pending") return fail(); const entry = (await this.#options.journal.read()).entries.find((item) => item.operation_handle === reserved.claim.operationHandle);
      if (!entry || entry.operation !== "export_evidence_volume" || entry.state !== "pending" || entry.request_digest !== reserved.claim.requestDigest) return fail();
      const admitted = await this.#options.authorityStore.loadAdmission(reserved.claim.operationHandle); const exportValue: ExportContext = { descriptor_digest: admitted.descriptor_digest, evidence_volume_handle: admitted.evidence_volume.resultHandle, run_id: parseRunId(admitted.run_id), selected_target: admitted.selected_target };
      if (admitted.operation_handle !== reserved.claim.operationHandle || admitted.request_digest !== reserved.claim.requestDigest || admitted.helper_contract !== this.#options.helperArtifactContract || exportValue.run_id !== value.run_id || exportValue.descriptor_digest !== value.descriptor_digest || !same(exportValue.selected_target, value.selected_target)) return fail(); await this.#options.authorityStore.requireDestination(admitted, destination);
      if (await this.#options.authorityStore.clearStaleExportClaim(admitted)) return incomplete(); const exportClaim = await this.#options.authorityStore.claimExport(admitted); if (exportClaim === null) return incomplete();
      try { const authority = await authorityFor(exportValue, this.#options); const helper = await helperFor(exportValue, this.#options); await selectedContextMatches(exportValue, this.#options); if (!same(admitted.evidence_volume, authority) || !same(admitted.helper, helper)) return fail(); await inspectAuthority(authority, this.#options); await inspectHelperImage(helper, this.#options); return await this.publishExport(exportValue, admitted, authority, reserved.claim, destination); } finally { await this.#options.authorityStore.releaseExport(admitted, exportClaim); }
    } catch (error) { if (isEvidenceExportIncomplete(error)) throw error; return failWithCause(error); }
  }
}
export const createEvidenceExportOperations = (raw: EvidenceExportOperationsOptions): EvidenceExportOperations => new Operations(options(raw));
export const createEvidenceVolumeExport = createEvidenceExportOperations;
