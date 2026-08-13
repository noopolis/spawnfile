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
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { createExistingDockerSecretSpec } from "./dockerSecretsProvider.js";
import {
  WORLD_SERVICE_ERROR,
  parseWorldServiceResolution,
  type WorldServiceResolution
} from "./dockerWorldServiceAuthority.js";
import {
  createDockerWorldServiceSpec,
  type DockerWorldServiceSpec
} from "./dockerWorldServiceProvider.js";

const BINDING_VERSION = "spawnfile.target-world-service.private-binding.v1" as const;
const ADMISSION_VERSION =
  "spawnfile.target-world-service.private-mutation-admission.v1" as const;
const MAX_RECORD_BYTES = 65_536;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const CONTAINER_NAME_PATTERN = /^spfc_[a-f0-9]{58}$/u;

interface NamedResourceBinding {
  readonly handle: OpaqueTargetHandle;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
}

export interface WorldServiceBinding {
  readonly container_id: string;
  readonly receipt_labels: Readonly<Record<string, string>>;
  readonly resolution: WorldServiceResolution;
  readonly resources: {
    readonly data_network: NamedResourceBinding;
    readonly evidence_volume: NamedResourceBinding;
    readonly secret_bindings: NamedResourceBinding;
  };
  readonly version: typeof BINDING_VERSION;
  readonly world_service_handle: OpaqueTargetHandle;
}

export interface WorldServiceMutationAdmission {
  readonly container_id: string | null;
  readonly container_name: string;
  readonly operation: "create_world_service" | "start_world_service" | "stop_world_service";
  readonly operation_handle: OpaqueTargetHandle;
  readonly request_digest: string;
  readonly version: typeof ADMISSION_VERSION;
  readonly world_service_handle: OpaqueTargetHandle;
}

export interface WorldServiceAuthorityStore {
  bindMutationAdmission(admission: WorldServiceMutationAdmission): Promise<void>;
  bindResolution(resolution: WorldServiceResolution): Promise<void>;
  bindService(binding: WorldServiceBinding): Promise<void>;
  loadService(handle: OpaqueTargetHandle): Promise<WorldServiceBinding>;
  requireMutationAdmission(admission: WorldServiceMutationAdmission): Promise<void>;
}

export interface WorldServiceAuthorityReader {
  loadService(handle: OpaqueTargetHandle): Promise<WorldServiceBinding>;
}

const fail = (): never => { throw new Error(WORLD_SERVICE_ERROR); };
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const ordinary = (raw: unknown): void => {
  try { assertOrdinaryJsonGraph(raw); } catch { return fail(); }
};
const record = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
  && Object.getPrototypeOf(raw) === Object.prototype;
const exactKeys = (raw: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(raw).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
};
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const key = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-world-service.${domain}.v1\0`, "utf8")
  .update(value, "utf8").digest("hex");
const stringRecord = (raw: unknown): Readonly<Record<string, string>> => {
  if (!record(raw) || Object.keys(raw).length < 1 || Object.keys(raw).length > 16) return fail();
  for (const [name, value] of Object.entries(raw)) {
    if (name.length < 1 || name.length > 128 || typeof value !== "string"
      || value.length < 1 || value.length > 128) return fail();
  }
  return Object.freeze({ ...raw }) as Readonly<Record<string, string>>;
};

const resource = (raw: unknown): NamedResourceBinding => {
  if (!record(raw) || !exactKeys(raw, ["handle", "labels", "name"])
    || typeof raw.name !== "string") return fail();
  return Object.freeze({
    handle: parseOpaqueTargetHandle(raw.handle),
    labels: stringRecord(raw.labels),
    name: raw.name
  });
};

const specFor = (
  resolution: WorldServiceResolution,
  resources: WorldServiceBinding["resources"]
): DockerWorldServiceSpec => createDockerWorldServiceSpec({
  dataNetwork: resources.data_network,
  evidenceMountPath: resolution.authorization.evidence_mount_path,
  evidenceVolume: resources.evidence_volume,
  imageDigest: resolution.artifact.image_digest,
  imageReference: resolution.artifact.image_reference,
  operationHandle: resolution.authorization.operation_handle,
  requestDigest: resolution.authorization.request_digest,
  runId: resolution.authorization.run_id,
  secretBindings: resources.secret_bindings,
  selectedTargetHandle: resolution.authorization.selected_target.handle,
  ...(resolution.artifact.identity_kind === "docker_image_config_digest"
    ? { networkAlias: resolution.artifact.network_alias } : {})
});

export const createWorldServiceBinding = (input: {
  readonly containerId: unknown;
  readonly dataNetwork: unknown;
  readonly evidenceVolume: unknown;
  readonly resolution: unknown;
  readonly secretBindings: unknown;
  readonly spec: DockerWorldServiceSpec;
}): WorldServiceBinding => {
  const resolution = parseWorldServiceResolution(input.resolution);
  if (typeof input.containerId !== "string" || !CONTAINER_ID_PATTERN.test(input.containerId)) return fail();
  const resources = Object.freeze({
    data_network: resource(input.dataNetwork),
    evidence_volume: resource(input.evidenceVolume),
    secret_bindings: resource(input.secretBindings)
  });
  if (resources.data_network.handle !== resolution.authorization.data_network_handle
    || resources.evidence_volume.handle !== resolution.authorization.evidence_volume_handle
    || resources.secret_bindings.handle !== resolution.authorization.secret_bindings_handle) return fail();
  const expected = specFor(resolution, resources);
  if (!same(expected, input.spec)) return fail();
  return Object.freeze({
    container_id: input.containerId,
    receipt_labels: expected.receiptLabels,
    resolution,
    resources,
    version: BINDING_VERSION,
    world_service_handle: expected.resultHandle
  });
};

export const parseWorldServiceBinding = (raw: unknown): WorldServiceBinding => {
  ordinary(raw);
  if (!record(raw) || !exactKeys(raw, [
    "container_id", "receipt_labels", "resolution", "resources", "version",
    "world_service_handle"
  ]) || raw.version !== BINDING_VERSION || !record(raw.resources)
    || !exactKeys(raw.resources, ["data_network", "evidence_volume", "secret_bindings"])) {
    return fail();
  }
  const resolution = parseWorldServiceResolution(raw.resolution);
  const resources = {
    data_network: resource(raw.resources.data_network),
    evidence_volume: resource(raw.resources.evidence_volume),
    secret_bindings: resource(raw.resources.secret_bindings)
  };
  const spec = specFor(resolution, resources);
  const binding = createWorldServiceBinding({
    containerId: raw.container_id,
    dataNetwork: resources.data_network,
    evidenceVolume: resources.evidence_volume,
    resolution,
    secretBindings: resources.secret_bindings,
    spec
  });
  if (binding.world_service_handle !== raw.world_service_handle
    || !same(binding.receipt_labels, stringRecord(raw.receipt_labels))) return fail();
  return binding;
};

export const createWorldServiceMutationAdmission = (input: {
  readonly containerId: unknown;
  readonly containerName: unknown;
  readonly operation: unknown;
  readonly operationHandle: unknown;
  readonly requestDigest: unknown;
  readonly worldServiceHandle: unknown;
}): WorldServiceMutationAdmission => {
  if (input.operation !== "create_world_service"
    && input.operation !== "start_world_service"
    && input.operation !== "stop_world_service"
    || typeof input.containerName !== "string"
    || !CONTAINER_NAME_PATTERN.test(input.containerName)
    || typeof input.requestDigest !== "string" || !DIGEST_PATTERN.test(input.requestDigest)
    || input.operation === "create_world_service" && input.containerId !== null
    || input.operation !== "create_world_service"
      && (typeof input.containerId !== "string" || !CONTAINER_ID_PATTERN.test(input.containerId))) {
    return fail();
  }
  return Object.freeze({
    container_id: input.containerId as string | null,
    container_name: input.containerName,
    operation: input.operation,
    operation_handle: parseOpaqueTargetHandle(input.operationHandle),
    request_digest: input.requestDigest,
    version: ADMISSION_VERSION,
    world_service_handle: parseOpaqueTargetHandle(input.worldServiceHandle)
  });
};

const parseAdmission = (raw: unknown): WorldServiceMutationAdmission => {
  ordinary(raw);
  if (!record(raw) || !exactKeys(raw, [
    "container_id", "container_name", "operation", "operation_handle",
    "request_digest", "version", "world_service_handle"
  ]) || raw.version !== ADMISSION_VERSION) return fail();
  return createWorldServiceMutationAdmission({
    containerId: raw.container_id,
    containerName: raw.container_name,
    operation: raw.operation,
    operationHandle: raw.operation_handle,
    requestDigest: raw.request_digest,
    worldServiceHandle: raw.world_service_handle
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

const checkExistingRoot = async (raw: unknown): Promise<string> => {
  if (typeof raw !== "string" || raw.length < 1 || bytes(raw) > 4_096
    || !path.isAbsolute(raw) || path.normalize(raw) !== raw) return fail();
  const parsed = path.parse(raw); let current = parsed.root; let stats;
  for (const part of raw.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { stats = await lstat(current); } catch { return fail(); }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return fail();
  }
  const owner = process.getuid?.();
  if (!stats || current !== raw || (stats.mode & 0o777) !== 0o700
    || owner !== undefined && stats.uid !== owner) return fail();
  return raw;
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
  const temporaryPath = path.join(root, `.${fileName}.${process.pid}.${randomUUID()}.tmp`); let handle;
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

class FileWorldServiceAuthorityStore implements WorldServiceAuthorityStore {
  readonly #root: string;
  public constructor(root: string) { this.#root = root; }
  public async bindResolution(raw: WorldServiceResolution): Promise<void> {
    const resolution = parseWorldServiceResolution(raw);
    await createImmutable(this.#root, `${key("resolution", resolution.authorization.operation_handle)}.resolution.json`, JSON.stringify(resolution));
  }
  public async bindService(raw: WorldServiceBinding): Promise<void> {
    const binding = parseWorldServiceBinding(raw);
    await createImmutable(this.#root, `${key("binding", binding.world_service_handle)}.service.json`, JSON.stringify(binding));
  }
  public async loadService(handle: OpaqueTargetHandle): Promise<WorldServiceBinding> {
    const parsed = parseOpaqueTargetHandle(handle);
    const content = await readPrivate(path.join(this.#root, `${key("binding", parsed)}.service.json`));
    if (content === null) return fail();
    try { return parseWorldServiceBinding(JSON.parse(content)); } catch { return fail(); }
  }
  public async bindMutationAdmission(raw: WorldServiceMutationAdmission): Promise<void> {
    const admission = parseAdmission(raw);
    await createImmutable(this.#root, `${key("admission", admission.operation_handle)}.admission.json`, JSON.stringify(admission));
  }
  public async requireMutationAdmission(raw: WorldServiceMutationAdmission): Promise<void> {
    const admission = parseAdmission(raw);
    const content = await readPrivate(path.join(this.#root, `${key("admission", admission.operation_handle)}.admission.json`));
    if (content !== JSON.stringify(admission)) return fail();
  }
}

class FileWorldServiceAuthorityReader implements WorldServiceAuthorityReader {
  readonly #root: string;
  public constructor(root: string) { this.#root = root; }
  public async loadService(handle: OpaqueTargetHandle): Promise<WorldServiceBinding> {
    const parsed = parseOpaqueTargetHandle(handle);
    const content = await readPrivate(path.join(
      this.#root,
      `${key("binding", parsed)}.service.json`
    ));
    if (content === null) return fail();
    try { return parseWorldServiceBinding(JSON.parse(content)); } catch { return fail(); }
  }
}

export const initializeWorldServiceAuthorityStore = async (
  root: unknown
): Promise<WorldServiceAuthorityStore> =>
  new FileWorldServiceAuthorityStore(await checkRoot(root));

/** Opens an existing private authority for reads without creating or chmodding paths. */
export const initializeWorldServiceAuthorityReader = async (
  root: unknown
): Promise<WorldServiceAuthorityReader> =>
  new FileWorldServiceAuthorityReader(await checkExistingRoot(root));

export const worldServiceResourceBindings = (input: {
  readonly dataNetworkClaim: { readonly operationHandle: OpaqueTargetHandle; readonly requestDigest: string };
  readonly evidenceVolumeClaim: { readonly operationHandle: OpaqueTargetHandle; readonly requestDigest: string };
  readonly resolution: WorldServiceResolution;
}): WorldServiceBinding["resources"] => {
  const authorization = input.resolution.authorization;
  const network = createDockerResourceSpec({ kind: "data_network", ...input.dataNetworkClaim,
    runId: authorization.run_id, selectedTargetHandle: authorization.selected_target.handle });
  const evidence = createDockerResourceSpec({ kind: "evidence_volume", ...input.evidenceVolumeClaim,
    runId: authorization.run_id, selectedTargetHandle: authorization.selected_target.handle });
  const secrets = createExistingDockerSecretSpec({ bindingsHandle: authorization.secret_bindings_handle,
    runId: authorization.run_id, selectedTargetHandle: authorization.selected_target.handle });
  if (network.resultHandle !== authorization.data_network_handle
    || evidence.resultHandle !== authorization.evidence_volume_handle) return fail();
  return Object.freeze({
    data_network: Object.freeze({ handle: network.resultHandle, labels: network.labels, name: network.name }),
    evidence_volume: Object.freeze({ handle: evidence.resultHandle, labels: evidence.labels, name: evidence.name }),
    secret_bindings: Object.freeze({ handle: secrets.resultHandle, labels: secrets.labels, name: secrets.volumeName })
  });
};
