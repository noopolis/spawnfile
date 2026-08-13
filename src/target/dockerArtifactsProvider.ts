import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { assertOrdinaryJsonGraph, parseOpaqueTargetHandle, type OpaqueTargetHandle } from "./contracts.js";
import type {
  DockerArtifactIdentityBinding,
  DockerArtifactIdentityStore,
  DockerArtifactIdentityStoreOptions,
  DockerConfigArtifactIdentityBinding,
  DockerOciArtifactIdentityBinding
} from "./dockerArtifactIdentityTypes.js";

export type {
  DockerArtifactIdentityBinding,
  DockerArtifactIdentityStore,
  DockerArtifactIdentityStoreOptions,
  DockerConfigArtifactIdentityBinding,
  DockerOciArtifactIdentityBinding
} from "./dockerArtifactIdentityTypes.js";

export const DOCKER_ARTIFACT_ERROR = "Docker artifact resolution failed";
export const DOCKER_ARTIFACT_INSPECTION_FORMAT = "[{\"RepoDigests\":{{json .RepoDigests}}}]";
const MAX_OUTPUT_BYTES = 32_768;
const MAX_REPOSITORY_BYTES = 255;
const MAX_REFERENCE_BYTES = MAX_REPOSITORY_BYTES + 72;
const MAX_IDENTITY_BYTES = 262_144;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/u;
const NAME_COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/u;
const DOMAIN_COMPONENT_PATTERN = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/u;

export interface DockerArtifactExecutor {
  (file: string, args: string[], options: { signal?: AbortSignal; timeout: number }): Promise<{ stderr: string; stdout: string }>;
}

export class DockerArtifactProviderError extends Error {
  public readonly kind: "image_not_found";
  public constructor(kind: "image_not_found") {
    super(DOCKER_ARTIFACT_ERROR);
    this.kind = kind;
  }
}

export interface DockerArtifactMapping {
  readonly artifact_manifest_digest: string;
  readonly image_digest: string;
  readonly image_reference: string;
}

export interface DockerArtifactSpec {
  readonly imageDigest: string;
  readonly imageReference: string;
  readonly inspectionFormat: typeof DOCKER_ARTIFACT_INSPECTION_FORMAT;
  readonly labels: Readonly<Record<string, string>>;
  readonly resultHandle: OpaqueTargetHandle;
}

export interface DockerConfigArtifactSpec {
  readonly configId: string;
  readonly imageDigest: string;
  readonly imageReference: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly resultHandle: OpaqueTargetHandle;
}

const fail = (): never => { throw new Error(DOCKER_ARTIFACT_ERROR); };
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const exactMatch = (pattern: RegExp, value: string): boolean => pattern.exec(value)?.[0] === value;
const digest = (domain: string, value: string): string => createHash("sha256")
  .update(`spawnfile.target-artifact.${domain}.v1\0`, "utf8").update(value, "utf8").digest("hex");
const label = (prefix: string, value: string): string => `${prefix}${digest("label", value).slice(0, 63)}`;

const isDigest = (value: unknown): value is string => typeof value === "string" && exactMatch(DIGEST_PATTERN, value);
const isRegistry = (value: string): boolean => {
  const colon = value.lastIndexOf(":");
  const host = colon < 0 ? value : value.slice(0, colon);
  const port = colon < 0 ? null : value.slice(colon + 1);
  if (host.length < 1 || host.length > 253 || host.includes(":")) return false;
  if (port !== null && (!exactMatch(PORT_PATTERN, port) || Number(port) > 65_535)) return false;
  return host.split(".").every((part) => exactMatch(DOMAIN_COMPONENT_PATTERN, part));
};
const isRepository = (value: string): boolean => {
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0)) return false;
  if (parts.length > 1 && (parts[0] === "localhost" || parts[0]!.includes(".") || parts[0]!.includes(":"))) {
    if (!isRegistry(parts.shift()!)) return false;
  }
  return parts.length > 0 && parts.every((part) => exactMatch(NAME_COMPONENT_PATTERN, part));
};

export const isImmutableDockerImageReference = (value: unknown): value is string => {
  if (typeof value !== "string" || bytes(value) > MAX_REFERENCE_BYTES || value !== value.toLowerCase()) return false;
  const separator = value.indexOf("@");
  if (separator < 1 || separator !== value.lastIndexOf("@")) return false;
  const repository = value.slice(0, separator);
  return bytes(repository) <= MAX_REPOSITORY_BYTES && isRepository(repository) && isDigest(value.slice(separator + 1));
};

export const parseDockerArtifactMappings = (raw: unknown): readonly DockerArtifactMapping[] => {
  try {
    assertOrdinaryJsonGraph(raw);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) return fail();
    const manifests = new Set<string>(); const imageDigests = new Set<string>(); const references = new Set<string>();
    const mappings = raw.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).sort().join("\0") !== "artifact_manifest_digest\0image_digest\0image_reference") return fail();
      const manifest = record.artifact_manifest_digest; const imageDigest = record.image_digest; const reference = record.image_reference;
      if (!isDigest(manifest) || !isDigest(imageDigest)
        || !isImmutableDockerImageReference(reference) || !reference.endsWith(`@${imageDigest}`)
        || manifests.has(manifest) || imageDigests.has(imageDigest) || references.has(reference)) return fail();
      manifests.add(manifest); imageDigests.add(imageDigest); references.add(reference);
      return Object.freeze({ artifact_manifest_digest: manifest, image_digest: imageDigest, image_reference: reference });
    });
    return Object.freeze(mappings);
  } catch { return fail(); }
};

const identityBase = (input: DockerArtifactIdentityBinding) => {
  const operationHandle = parseOpaqueTargetHandle(input.operationHandle);
  const resultHandle = parseOpaqueTargetHandle(input.resultHandle);
  const selectedTargetHandle = parseOpaqueTargetHandle(input.selectedTargetHandle);
  if (!isDigest(input.requestDigest) || !isDigest(input.artifactManifestDigest)) return fail();
  return Object.freeze({ artifact_manifest_digest: input.artifactManifestDigest,
    operation_handle: operationHandle, request_digest: input.requestDigest,
    result_handle: resultHandle, selected_target_handle: selectedTargetHandle });
};
const bindingBytes = (input: DockerArtifactIdentityBinding): string => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) return fail();
    const keys = Object.keys(input).sort().join("\0");
    const oci = "artifactManifestDigest\0imageDigest\0imageReference\0operationHandle\0requestDigest\0resultHandle\0selectedTargetHandle";
    const ociTagged = `${oci}\0identityKind`.split("\0").sort().join("\0");
    const config = "archiveDigest\0artifactManifestDigest\0baseImageConfigDigest\0buildPolicyDigest\0bundleDigest\0configId\0daemonEpoch\0entrypoint\0gcTag\0identityKind\0launcherDigest\0networkAlias\0operationHandle\0platform\0platformDigest\0preparedOperationHandle\0preparedRequestDigest\0requestDigest\0resultHandle\0selectedTargetHandle";
    if ((input.identityKind === "docker_image_config_digest" && keys !== config)
      || (input.identityKind !== "docker_image_config_digest" && keys !== oci && keys !== ociTagged)) return fail();
    if (input.identityKind === "oci_image_manifest" && descriptors.identityKind?.enumerable === false
      && keys !== oci) return fail();
  } catch { return fail(); }
  const base = identityBase(input);
  if (input.identityKind === "docker_image_config_digest") {
    if (!isDigest(input.archiveDigest) || !isDigest(input.baseImageConfigDigest)
      || !isDigest(input.buildPolicyDigest) || !isDigest(input.bundleDigest) || !isDigest(input.configId)
      || !isDigest(input.daemonEpoch) || !isDigest(input.launcherDigest) || !isDigest(input.platformDigest)
      || !isDigest(input.preparedRequestDigest)
      || typeof input.gcTag !== "string" || !/^spfb_[a-f0-9]{58}$/u.test(input.gcTag)
      || typeof input.entrypoint !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(input.entrypoint)
      || input.entrypoint.includes("//") || input.entrypoint.split("/").some((part) => part === "." || part === "..")
      || typeof input.networkAlias !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(input.networkAlias)
      || !input.platform || (input.platform.architecture !== "amd64" && input.platform.architecture !== "arm64")
      || input.platform.os !== "linux") return fail();
    const preparedOperationHandle = parseOpaqueTargetHandle(input.preparedOperationHandle);
    return JSON.stringify({
      ...base, archive_digest: input.archiveDigest, base_image_config_digest: input.baseImageConfigDigest,
      build_policy_digest: input.buildPolicyDigest, bundle_digest: input.bundleDigest, config_id: input.configId,
      daemon_epoch: input.daemonEpoch, entrypoint: input.entrypoint, gc_tag: input.gcTag,
      identity_kind: input.identityKind,
      launcher_digest: input.launcherDigest, network_alias: input.networkAlias,
      platform: input.platform, platform_digest: input.platformDigest,
      prepared_operation_handle: preparedOperationHandle,
      prepared_request_digest: input.preparedRequestDigest,
      version: "spawnfile.target-artifact.identity.v3"
    });
  }
  if (input.identityKind !== undefined && input.identityKind !== "oci_image_manifest") return fail();
  const [mapping] = parseDockerArtifactMappings([{
    artifact_manifest_digest: input.artifactManifestDigest,
    image_digest: input.imageDigest,
    image_reference: input.imageReference
  }]);
  if (!mapping) return fail();
  return JSON.stringify({
    ...base, artifact_manifest_digest: mapping.artifact_manifest_digest,
    identity_kind: "oci_image_manifest", image_digest: mapping.image_digest,
    image_reference: mapping.image_reference,
    version: "spawnfile.target-artifact.identity.v2"
  });
};
const parseBinding = (text: string): DockerArtifactIdentityBinding => {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.version !== "spawnfile.target-artifact.identity.v2"
      && value.version !== "spawnfile.target-artifact.identity.v3") return fail();
    let parsed: DockerArtifactIdentityBinding;
    if (value.identity_kind === "oci_image_manifest"
      && Object.keys(value).sort().join("\0") === "artifact_manifest_digest\0identity_kind\0image_digest\0image_reference\0operation_handle\0request_digest\0result_handle\0selected_target_handle\0version") {
      const oci = {
        artifactManifestDigest: value.artifact_manifest_digest as string,
        imageDigest: value.image_digest as string, imageReference: value.image_reference as string,
        operationHandle: parseOpaqueTargetHandle(value.operation_handle), requestDigest: value.request_digest as string,
        resultHandle: parseOpaqueTargetHandle(value.result_handle), selectedTargetHandle: parseOpaqueTargetHandle(value.selected_target_handle)
      };
      Object.defineProperty(oci, "identityKind", { enumerable: false, value: "oci_image_manifest" });
      parsed = Object.freeze(oci as DockerOciArtifactIdentityBinding);
    } else if (value.version === "spawnfile.target-artifact.identity.v3"
      && value.identity_kind === "docker_image_config_digest"
      && Object.keys(value).sort().join("\0") === "archive_digest\0artifact_manifest_digest\0base_image_config_digest\0build_policy_digest\0bundle_digest\0config_id\0daemon_epoch\0entrypoint\0gc_tag\0identity_kind\0launcher_digest\0network_alias\0operation_handle\0platform\0platform_digest\0prepared_operation_handle\0prepared_request_digest\0request_digest\0result_handle\0selected_target_handle\0version") {
      parsed = Object.freeze({
        archiveDigest: value.archive_digest as string, artifactManifestDigest: value.artifact_manifest_digest as string,
        baseImageConfigDigest: value.base_image_config_digest as string,
        buildPolicyDigest: value.build_policy_digest as string, bundleDigest: value.bundle_digest as string,
        configId: value.config_id as string, daemonEpoch: value.daemon_epoch as string,
        entrypoint: value.entrypoint as string, gcTag: value.gc_tag as string, identityKind: "docker_image_config_digest" as const,
        launcherDigest: value.launcher_digest as string, networkAlias: value.network_alias as string,
        operationHandle: parseOpaqueTargetHandle(value.operation_handle), requestDigest: value.request_digest as string,
        preparedOperationHandle: parseOpaqueTargetHandle(value.prepared_operation_handle),
        preparedRequestDigest: value.prepared_request_digest as string,
        resultHandle: parseOpaqueTargetHandle(value.result_handle), selectedTargetHandle: parseOpaqueTargetHandle(value.selected_target_handle),
        platform: value.platform as { architecture: "amd64" | "arm64"; os: "linux" }, platformDigest: value.platform_digest as string
      });
    } else return fail();
    if (bindingBytes(parsed) !== text) return fail();
    return parsed;
  } catch { return fail(); }
};
const OWNER = process.getuid?.() ?? -1;
const checkIdentityRoot = async (raw: unknown): Promise<string> => {
  if (typeof raw !== "string" || raw.length < 1 || bytes(raw) > 4_096) return fail();
  const root = path.resolve(raw); const parsed = path.parse(root);
  /* Never treat the platform filesystem root as a private Spawnfile boundary. */
  if (root === parsed.root) return fail();
  let current = parsed.root; let createdRoot = false;
  for (const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let stats; let created = false;
    try { stats = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
      try { await mkdir(current, { mode: 0o700 }); created = true; }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") return fail(); }
      stats = await lstat(current).catch(fail);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return fail();
    if (current === root) {
      createdRoot = created;
      if (!createdRoot && (stats.uid !== OWNER || (stats.mode & 0o777) !== 0o700)) return fail();
    }
  }
  if (createdRoot) await chmod(root, 0o700).catch(fail);
  const final = await lstat(root).catch(fail);
  if (!final.isDirectory() || final.isSymbolicLink() || final.uid !== OWNER || (final.mode & 0o777) !== 0o700) return fail();
  return root;
};
interface IdentityFile { readonly bytes: string; readonly dev: number; readonly ino: number; readonly nlink: number; }
const secureIdentity = (stats: { readonly isFile: () => boolean; readonly uid: number; readonly size: number; readonly mode: number; readonly nlink: number }): void => {
  if (!stats.isFile() || stats.uid !== OWNER || stats.size > MAX_IDENTITY_BYTES || (stats.mode & 0o777) !== 0o600) fail();
};
const openSecureIdentity = async (filePath: string): Promise<IdentityFile | null> => {
  let handle;
  try { handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
  try {
    const current = await handle.stat(); secureIdentity(current);
    return { bytes: await handle.readFile({ encoding: "utf8" }), dev: current.dev, ino: current.ino, nlink: current.nlink };
  } catch { return fail(); } finally { await handle.close().catch(() => undefined); }
};
const openIdentity = async (filePath: string, links: readonly number[]): Promise<IdentityFile | null> => {
  const value = await openSecureIdentity(filePath); if (value !== null && !links.includes(value.nlink)) return fail(); return value;
};
const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); }
};
/* One canonical immutable record exists for one exact operation/request pair. */
const keyPath = (root: string, operationHandle: string, requestDigest: string): string =>
  path.join(root, `${digest("identity-operation", `${operationHandle}\0${requestDigest}`)}.identity.json`);
const pendingPath = (file: string): string => path.join(path.dirname(file), `.${path.basename(file)}.pending`);
const sameInode = (left: IdentityFile, right: IdentityFile): boolean => left.dev === right.dev && left.ino === right.ino;
/*
 * The two names below live in a root owned exclusively by the Spawnfile uid and
 * checked mode-0700 on every store construction.  We defend each operation
 * boundary against malformed, linked, wrong-mode, wrong-owner, or symlinked
 * records.  A malicious concurrent process with that same uid is out of scope:
 * it already controls Spawnfile state and code.  That narrow trust boundary is
 * what makes unlink-after-same-inode-proof safe here.
 */
const reconcilePublishedIdentity = async (root: string, file: string, expected: string): Promise<void> => {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const final = await openIdentity(file, [1, 2]);
    if (!final || final.bytes !== expected) return fail();
    const pending = await openIdentity(pendingPath(file), [1, 2]);
    if (final.nlink === 1) {
      if (pending === null) return;
      if (pending.bytes !== expected) return fail();
      if (pending.nlink !== 1) continue;
    } else {
      /* A concurrent unlink can make a just-read two-link final become one-link. */
      if (pending === null || pending.nlink !== 2) continue;
      if (!sameInode(final, pending) || pending.bytes !== expected) return fail();
    }
    /* Safe only under the trusted-root boundary documented above. */
    await unlink(pendingPath(file)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") fail(); });
    await syncDirectory(root);
    const repaired = await openIdentity(file, [1]);
    if (!repaired || repaired.bytes !== expected) return fail();
    if (await openIdentity(pendingPath(file), [1]) === null) return;
  }
  return fail();
};
const readPublishedIdentity = async (root: string, file: string): Promise<string | null> => {
  const final = await openIdentity(file, [1, 2]);
  if (final === null) return null;
  await reconcilePublishedIdentity(root, file, final.bytes);
  return final.bytes;
};
const exactPublishedIdentity = async (root: string, file: string, content: string): Promise<boolean> => {
  const prior = await readPublishedIdentity(root, file); if (prior === null) return false;
  if (prior !== content) return fail(); return true;
};
const publishIdentity = async (root: string, file: string, content: string, options?: DockerArtifactIdentityStoreOptions): Promise<void> => {
  const pending = pendingPath(file);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await exactPublishedIdentity(root, file, content)) return;
    let created = false; let handle;
    try {
      handle = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true; await handle.chmod(0o600); await handle.writeFile(content, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await syncDirectory(root);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fail();
      await options?.afterPendingExists?.();
    }
    if (created) await options?.beforePublish?.();
    const pendingRecord = await openIdentity(pending, [1, 2]);
    if (pendingRecord === null) {
      if (await exactPublishedIdentity(root, file, content)) return;
      continue;
    }
    if (pendingRecord.bytes !== content) return fail();
    if (pendingRecord.nlink === 2) {
      if (await exactPublishedIdentity(root, file, content)) return;
      continue;
    }
    if (created) await options?.beforeLink?.();
    try {
      await link(pending, file); await syncDirectory(root);
      await options?.afterLinkBeforePendingUnlink?.();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOENT") return fail();
    }
    /* EEXIST may mean another exact binder linked first or a final vanished; retry only after an exact proof. */
    if (await exactPublishedIdentity(root, file, content)) return;
  }
  return fail();
};
class FileDockerArtifactIdentityStore implements DockerArtifactIdentityStore {
  readonly #root: string;
  readonly #options?: DockerArtifactIdentityStoreOptions;
  public constructor(root: string, options?: DockerArtifactIdentityStoreOptions) { this.#root = root; this.#options = options; }
  public async bind(input: DockerArtifactIdentityBinding): Promise<void> {
    try { const binding = parseBinding(bindingBytes(input)); const content = bindingBytes(binding);
      const operation = keyPath(this.#root, binding.operationHandle, binding.requestDigest);
      await publishIdentity(this.#root, operation, content, this.#options);
    } catch { return fail(); }
  }
  public async resolveOperation(rawOperation: OpaqueTargetHandle, rawRequest: string): Promise<DockerArtifactIdentityBinding | null> {
    try { const operationHandle = parseOpaqueTargetHandle(rawOperation); if (!isDigest(rawRequest)) return fail();
      const text = await readPublishedIdentity(this.#root, keyPath(this.#root, operationHandle, rawRequest)); if (text === null) return null;
      const binding = parseBinding(text); if (binding.operationHandle !== operationHandle || binding.requestDigest !== rawRequest) return fail(); return binding;
    } catch { return fail(); }
  }
}
export const initializeDockerArtifactIdentityStore = async (root: unknown, options?: DockerArtifactIdentityStoreOptions): Promise<DockerArtifactIdentityStore> =>
  new FileDockerArtifactIdentityStore(await checkIdentityRoot(root), options);

export { createDockerArtifactSpec, createDockerConfigArtifactSpec, executeDockerArtifact, isExpectedDockerArtifact } from "./dockerArtifactInspection.js";
