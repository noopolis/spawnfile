import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  assertOrdinaryJsonGraph,
  parseOpaqueTargetHandle,
  type OpaqueTargetHandle
} from "./contracts.js";
import {
  ORGANIZATION_ATTACHMENT_ERROR,
  createDockerOrganizationAttachmentSpec,
  parseOrganizationContainerId,
  type DockerOrganizationAttachmentSpec
} from "./organizationAttachmentProvider.js";
import {
  parseOrganizationAttachmentResolution,
  type OrganizationAttachmentResolution
} from "./organizationAttachmentAuthority.js";

const RESOLUTION_VERSION =
  "spawnfile.target-organization-attachment.private-resolution.v1" as const;
const ATTACHMENT_VERSION =
  "spawnfile.target-organization-attachment.private-binding.v1" as const;
const MUTATION_ADMISSION_VERSION =
  "spawnfile.target-organization-attachment.private-mutation-admission.v1" as const;
const MAX_RECORD_BYTES = 32_768;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const NAME_PATTERN = /^spfn_[a-f0-9]{58}$/u;

export interface OrganizationAttachmentBinding {
  readonly attachment_handle: OpaqueTargetHandle;
  readonly data_network: {
    readonly handle: OpaqueTargetHandle;
    readonly id: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly name: string;
    readonly operation_handle: OpaqueTargetHandle;
    readonly request_digest: string;
  };
  readonly receipt_labels: Readonly<Record<string, string>>;
  readonly resolution: OrganizationAttachmentResolution;
  readonly version: typeof ATTACHMENT_VERSION;
}

export interface OrganizationAttachmentAuthorityStore {
  bindAttachment(binding: OrganizationAttachmentBinding): Promise<void>;
  bindMutationAdmission(admission: OrganizationAttachmentMutationAdmission): Promise<void>;
  bindResolution(resolution: OrganizationAttachmentResolution): Promise<void>;
  loadAttachment(handle: OpaqueTargetHandle): Promise<OrganizationAttachmentBinding>;
  requireMutationAdmission(admission: OrganizationAttachmentMutationAdmission): Promise<void>;
}

export interface OrganizationAttachmentMutationAdmission {
  readonly attachment_handle: OpaqueTargetHandle;
  readonly container_id: string;
  readonly data_network_id: string;
  readonly operation: "attach_organization" | "detach_organization";
  readonly operation_handle: OpaqueTargetHandle;
  readonly request_digest: string;
  readonly version: typeof MUTATION_ADMISSION_VERSION;
}

const fail = (): never => { throw new Error(ORGANIZATION_ATTACHMENT_ERROR); };
const ordinary = (raw: unknown): void => {
  try { assertOrdinaryJsonGraph(raw); } catch { return fail(); }
};
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const exactRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
};
const exactStringRecord = (raw: unknown): Readonly<Record<string, string>> => {
  if (!exactRecord(raw)) return fail();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || key.length < 1 || key.length > 128
      || value.length < 1 || value.length > 128) return fail();
  }
  return Object.freeze({ ...raw }) as Readonly<Record<string, string>>;
};
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const key = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-organization-attachment.${domain}.v1\0`, "utf8")
  .update(value, "utf8")
  .digest("hex");

export const createOrganizationAttachmentBinding = (input: {
  readonly dataNetworkOperationHandle: OpaqueTargetHandle;
  readonly dataNetworkRequestDigest: string;
  readonly networkId: unknown;
  readonly resolution: unknown;
  readonly spec: DockerOrganizationAttachmentSpec;
}): OrganizationAttachmentBinding => {
  const resolution = parseOrganizationAttachmentResolution(input.resolution);
  const networkId = parseOrganizationContainerId(input.networkId);
  if (!DIGEST_PATTERN.test(input.dataNetworkRequestDigest)) return fail();
  const expected = createDockerOrganizationAttachmentSpec({
    containerId: resolution.network_attachment.container_id,
    dataNetworkOperationHandle: input.dataNetworkOperationHandle,
    dataNetworkRequestDigest: input.dataNetworkRequestDigest,
    deploymentLabels: resolution.network_attachment.deployment_labels,
    operationHandle: resolution.authorization.operation_handle,
    organizationHandoffHandle: resolution.authorization.organization_handoff_handle,
    requestDigest: resolution.authorization.request_digest,
    runId: resolution.authorization.run_id,
    selectedTargetHandle: resolution.authorization.selected_target.handle
  });
  if (!same(expected, input.spec)) return fail();
  return Object.freeze({
    attachment_handle: expected.resultHandle,
    data_network: Object.freeze({
      handle: expected.network.resultHandle,
      id: networkId,
      labels: expected.network.labels,
      name: expected.network.name,
      operation_handle: parseOpaqueTargetHandle(input.dataNetworkOperationHandle),
      request_digest: input.dataNetworkRequestDigest
    }),
    receipt_labels: expected.receiptLabels,
    resolution,
    version: ATTACHMENT_VERSION
  });
};

export const parseOrganizationAttachmentBinding = (
  raw: unknown
): OrganizationAttachmentBinding => {
  ordinary(raw);
  if (!exactRecord(raw) || !exactKeys(raw, [
    "attachment_handle", "data_network", "receipt_labels", "resolution", "version"
  ]) || raw.version !== ATTACHMENT_VERSION || !exactRecord(raw.data_network)
    || !exactKeys(raw.data_network, [
      "handle", "id", "labels", "name", "operation_handle", "request_digest"
    ]) || typeof raw.data_network.name !== "string"
    || !NAME_PATTERN.test(raw.data_network.name)
    || typeof raw.data_network.request_digest !== "string"
    || !DIGEST_PATTERN.test(raw.data_network.request_digest)) return fail();
  const resolution = parseOrganizationAttachmentResolution(raw.resolution);
  const spec = createDockerOrganizationAttachmentSpec({
    containerId: resolution.network_attachment.container_id,
    dataNetworkOperationHandle: parseOpaqueTargetHandle(raw.data_network.operation_handle),
    dataNetworkRequestDigest: raw.data_network.request_digest,
    deploymentLabels: resolution.network_attachment.deployment_labels,
    operationHandle: resolution.authorization.operation_handle,
    organizationHandoffHandle: resolution.authorization.organization_handoff_handle,
    requestDigest: resolution.authorization.request_digest,
    runId: resolution.authorization.run_id,
    selectedTargetHandle: resolution.authorization.selected_target.handle
  });
  const networkLabels = exactStringRecord(raw.data_network.labels);
  const receiptLabels = exactStringRecord(raw.receipt_labels);
  if (raw.attachment_handle !== spec.resultHandle
    || raw.data_network.handle !== spec.network.resultHandle
    || raw.data_network.name !== spec.network.name
    || !same(networkLabels, spec.network.labels)
    || !same(receiptLabels, spec.receiptLabels)) return fail();
  return Object.freeze({
    attachment_handle: parseOpaqueTargetHandle(raw.attachment_handle),
    data_network: Object.freeze({
      handle: parseOpaqueTargetHandle(raw.data_network.handle),
      id: parseOrganizationContainerId(raw.data_network.id),
      labels: networkLabels,
      name: raw.data_network.name,
      operation_handle: parseOpaqueTargetHandle(raw.data_network.operation_handle),
      request_digest: raw.data_network.request_digest
    }),
    receipt_labels: receiptLabels,
    resolution,
    version: ATTACHMENT_VERSION
  });
};

export const createOrganizationAttachmentMutationAdmission = (input: {
  readonly binding: OrganizationAttachmentBinding;
  readonly operation: "attach_organization" | "detach_organization";
  readonly operationHandle: OpaqueTargetHandle;
  readonly requestDigest: string;
}): OrganizationAttachmentMutationAdmission => {
  const binding = parseOrganizationAttachmentBinding(input.binding);
  if (input.operation !== "attach_organization" && input.operation !== "detach_organization"
    || !DIGEST_PATTERN.test(input.requestDigest)) return fail();
  const operationHandle = parseOpaqueTargetHandle(input.operationHandle);
  if (input.operation === "attach_organization"
    && (operationHandle !== binding.resolution.authorization.operation_handle
      || input.requestDigest !== binding.resolution.authorization.request_digest)) return fail();
  return Object.freeze({
    attachment_handle: binding.attachment_handle,
    container_id: binding.resolution.network_attachment.container_id,
    data_network_id: binding.data_network.id,
    operation: input.operation,
    operation_handle: operationHandle,
    request_digest: input.requestDigest,
    version: MUTATION_ADMISSION_VERSION
  });
};

const parseMutationAdmission = (raw: unknown): OrganizationAttachmentMutationAdmission => {
  ordinary(raw);
  if (!exactRecord(raw) || !exactKeys(raw, [
    "attachment_handle", "container_id", "data_network_id", "operation",
    "operation_handle", "request_digest", "version"
  ]) || raw.version !== MUTATION_ADMISSION_VERSION
    || raw.operation !== "attach_organization" && raw.operation !== "detach_organization"
    || typeof raw.request_digest !== "string" || !DIGEST_PATTERN.test(raw.request_digest)) {
    return fail();
  }
  return Object.freeze({
    attachment_handle: parseOpaqueTargetHandle(raw.attachment_handle),
    container_id: parseOrganizationContainerId(raw.container_id),
    data_network_id: parseOrganizationContainerId(raw.data_network_id),
    operation: raw.operation,
    operation_handle: parseOpaqueTargetHandle(raw.operation_handle),
    request_digest: raw.request_digest,
    version: MUTATION_ADMISSION_VERSION
  });
};

const checkRoot = async (raw: unknown): Promise<string> => {
  if (typeof raw !== "string" || raw.length < 1 || bytes(raw) > 4_096) return fail();
  const root = path.resolve(raw); const parsed = path.parse(root); let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let stats;
    try { stats = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
      await mkdir(current, { mode: 0o700 }).catch((mkdirError: NodeJS.ErrnoException) => {
        if (mkdirError.code !== "EEXIST") return fail();
      });
      stats = await lstat(current).catch(fail);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return fail();
  }
  await chmod(root, 0o700).catch(fail); return root;
};

const readPrivate = async (filePath: string): Promise<string | null> => {
  let stats;
  try { stats = await lstat(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_RECORD_BYTES
    || (stats.mode & 0o077) !== 0) return fail();
  let handle;
  try { handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return fail(); }
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_RECORD_BYTES || (current.mode & 0o077) !== 0) return fail();
    return await handle.readFile({ encoding: "utf8" });
  } catch { return fail(); } finally { await handle.close().catch(() => undefined); }
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
};

const createImmutable = async (root: string, fileName: string, content: string): Promise<void> => {
  if (bytes(content) > MAX_RECORD_BYTES) return fail();
  const finalPath = path.join(root, fileName); const existing = await readPrivate(finalPath);
  if (existing !== null) { if (existing !== content) return fail(); return; }
  const temporaryPath = path.join(root, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600); await handle.writeFile(content, "utf8"); await handle.sync();
    await handle.close(); handle = undefined;
    try { await link(temporaryPath, finalPath); await syncDirectory(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(root);
  }
  if (await readPrivate(finalPath) !== content) return fail();
};

class FileOrganizationAttachmentAuthorityStore implements OrganizationAttachmentAuthorityStore {
  readonly #root: string;
  public constructor(root: string) { this.#root = root; }
  public async bindResolution(raw: OrganizationAttachmentResolution): Promise<void> {
    const resolution = parseOrganizationAttachmentResolution(raw);
    const content = JSON.stringify({ resolution, version: RESOLUTION_VERSION });
    const fileName = `${key("resolution", resolution.authorization.organization_handoff_handle)}.resolution.json`;
    await createImmutable(this.#root, fileName, content);
  }
  public async bindAttachment(raw: OrganizationAttachmentBinding): Promise<void> {
    const binding = parseOrganizationAttachmentBinding(raw);
    const fileName = `${key("binding", binding.attachment_handle)}.attachment.json`;
    await createImmutable(this.#root, fileName, JSON.stringify(binding));
  }
  public async bindMutationAdmission(raw: OrganizationAttachmentMutationAdmission): Promise<void> {
    const admission = parseMutationAdmission(raw);
    const fileName = `${key("mutation-admission", admission.operation_handle)}.admission.json`;
    await createImmutable(this.#root, fileName, JSON.stringify(admission));
  }
  public async loadAttachment(handle: OpaqueTargetHandle): Promise<OrganizationAttachmentBinding> {
    const parsed = parseOpaqueTargetHandle(handle);
    const fileName = `${key("binding", parsed)}.attachment.json`;
    const content = await readPrivate(path.join(this.#root, fileName));
    if (content === null) return fail();
    try { return parseOrganizationAttachmentBinding(JSON.parse(content)); }
    catch { return fail(); }
  }
  public async requireMutationAdmission(raw: OrganizationAttachmentMutationAdmission): Promise<void> {
    const admission = parseMutationAdmission(raw);
    const fileName = `${key("mutation-admission", admission.operation_handle)}.admission.json`;
    if (await readPrivate(path.join(this.#root, fileName)) !== JSON.stringify(admission)) return fail();
  }
}

export const initializeOrganizationAttachmentAuthorityStore = async (
  root: unknown
): Promise<OrganizationAttachmentAuthorityStore> =>
  new FileOrganizationAttachmentAuthorityStore(await checkRoot(root));
