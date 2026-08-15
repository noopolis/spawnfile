import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { types as nodeTypes } from "node:util";

import { resolveSpawnfileHome } from "../auth/index.js";
import {
  parseDockerArtifactMappings,
  type DockerArtifactMapping
} from "../target/dockerArtifactsProvider.js";
export { resolveTargetDefaultJournalRoot } from "../target/journalRoot.js";

export const TARGET_DEFAULT_CONFIG_ERROR = "Target configuration failed";
const MAX_PATH_BYTES = 4_096;
const CONTEXT = /^[a-z][a-z0-9_-]{0,63}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CHILD_ROOTS = Object.freeze([
  "journals",
  "artifact-identities",
  "secret-authority",
  "attachment-authority",
  "world-authority",
  "evidence-export"
] as const);

export interface TargetDefaultConfigInputs {
  /**
   * Immutable artifact identities are configuration, not a late-bound provider
   * input.  Keeping them here makes the complete production input JSON data.
   */
  readonly artifactMappings?: readonly DockerArtifactMapping[];
  /**
   * Optional durable authority for immutable target-local container bundles.
   * It is deliberately independent from per-run lifecycle and secret roots.
   */
  readonly containerBundleStoreRoot?: string;
  readonly context: string;
  readonly dockerCommand: string;
  readonly evidenceDestination: string;
  readonly helperArtifactManifestDigest?: string;
  /** Local-Daemon prepared images, admitted only by manifest/bundle/policy. */
  readonly preparedArtifactMappings?: readonly PreparedArtifactMapping[];
  readonly timeoutMs: number;
}
export interface PreparedArtifactMapping {
  readonly archive_digest: string;
  readonly artifact_manifest_digest: string;
  readonly base_image_config_digest: string;
  readonly build_policy_digest: string;
  readonly bundle_digest: string;
  readonly entrypoint: string;
  readonly launcher_digest: string;
  readonly network_alias: string;
  readonly platform: { readonly architecture: "amd64" | "arm64"; readonly os: "linux" };
  readonly platform_digest: string;
}

export interface TargetDefaultConfig {
  readonly artifactMappings: readonly DockerArtifactMapping[];
  readonly context: string;
  readonly dockerCommand: string;
  readonly evidenceDestination: string;
  /** Present only when the private evidence-export helper was configured. */
  readonly helperArtifact?: DockerArtifactMapping;
  readonly preparedArtifactMappings: readonly PreparedArtifactMapping[];
  readonly paths: {
    readonly artifactIdentities: string;
    readonly attachmentAuthority: string;
    readonly evidenceExport: string;
    readonly containerBundles: string;
    readonly journals: string;
    readonly root: string;
    readonly secretAuthority: string;
    readonly worldAuthority: string;
  };
  readonly timeoutMs: number;
}

export interface TargetDefaultWorldReadinessConfig {
  readonly context: string;
  readonly dockerCommand: string;
  readonly paths: { readonly worldAuthority: string };
  readonly timeoutMs: number;
}

const fail = (): never => { throw new Error(TARGET_DEFAULT_CONFIG_ERROR); };
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const descriptorValues = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || nodeTypes.isProxy(raw)
    || Object.getPrototypeOf(raw) !== Object.prototype) return fail();
  const expected = [
    "artifactMappings", "containerBundleStoreRoot", "context", "dockerCommand", "evidenceDestination",
    "helperArtifactManifestDigest", "preparedArtifactMappings", "timeoutMs"
  ];
  const required = ["context", "dockerCommand", "evidenceDestination", "timeoutMs"];
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || required.some((key) => !keys.includes(key))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some((item) =>
    !item.enumerable || !("value" in item))) return fail();
  return Object.fromEntries(expected.filter((key) => Object.hasOwn(descriptors, key)).map((key) => [key, descriptors[key]!.value]));
};
export const parseTargetPreparedArtifactMappings = (
  raw: unknown
): readonly PreparedArtifactMapping[] => {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.length > 32) return fail();
  const manifests = new Set<string>();
  const mappings = raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || nodeTypes.isProxy(item)
      || Object.getPrototypeOf(item) !== Object.prototype) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return fail();
    const value = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) =>
      [key, (descriptor as PropertyDescriptor & { value: unknown }).value])) as Record<string, unknown>;
    if (Object.keys(value).sort().join("\0") !== "archive_digest\0artifact_manifest_digest\0base_image_config_digest\0build_policy_digest\0bundle_digest\0entrypoint\0launcher_digest\0network_alias\0platform\0platform_digest"
      || typeof value.artifact_manifest_digest !== "string" || !DIGEST.test(value.artifact_manifest_digest)
      || typeof value.archive_digest !== "string" || !DIGEST.test(value.archive_digest)
      || typeof value.base_image_config_digest !== "string" || !DIGEST.test(value.base_image_config_digest)
      || typeof value.bundle_digest !== "string" || !DIGEST.test(value.bundle_digest)
      || typeof value.build_policy_digest !== "string" || !DIGEST.test(value.build_policy_digest)
      || typeof value.launcher_digest !== "string" || !DIGEST.test(value.launcher_digest)
      || typeof value.platform_digest !== "string" || !DIGEST.test(value.platform_digest)
      || typeof value.entrypoint !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u.test(value.entrypoint)
      || value.entrypoint.includes("//") || value.entrypoint.split("/").some((part) => part === "." || part === "..")
      || typeof value.network_alias !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(value.network_alias)
      || !value.platform || typeof value.platform !== "object" || Array.isArray(value.platform) || nodeTypes.isProxy(value.platform)
      || Object.getPrototypeOf(value.platform) !== Object.prototype
      || Object.keys(value.platform as object).sort().join("\0") !== "architecture\0os"
      || Object.values(Object.getOwnPropertyDescriptors(value.platform)).some((descriptor) =>
        !descriptor.enumerable || !("value" in descriptor))
      || (value.platform as Record<string, unknown>).os !== "linux"
      || !["amd64", "arm64"].includes((value.platform as Record<string, unknown>).architecture as string)
      || manifests.has(value.artifact_manifest_digest)) return fail();
    manifests.add(value.artifact_manifest_digest);
    return Object.freeze({ archive_digest: value.archive_digest, artifact_manifest_digest: value.artifact_manifest_digest,
      base_image_config_digest: value.base_image_config_digest, build_policy_digest: value.build_policy_digest,
      bundle_digest: value.bundle_digest, entrypoint: value.entrypoint, launcher_digest: value.launcher_digest,
      network_alias: value.network_alias, platform: Object.freeze({ ...(value.platform as { architecture: "amd64" | "arm64"; os: "linux" }) }),
      platform_digest: value.platform_digest });
  });
  return Object.freeze(mappings);
};
const exactPath = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length < 1 || raw.includes("\0")
    || byteLength(raw) > MAX_PATH_BYTES || !path.isAbsolute(raw)
    || path.normalize(raw) !== raw) return fail();
  return raw;
};
const command = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.includes("\0") || byteLength(raw) > 1_024) return fail();
  if (COMMAND_NAME.test(raw)) return raw;
  if (!path.isAbsolute(raw) || path.normalize(raw) !== raw) return fail();
  return raw;
};
const ensureOwnedRoot = async (root: string): Promise<string> => {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
    try { await mkdir(root, { mode: 0o700 }); } catch { return fail(); }
    try { info = await lstat(root); } catch { return fail(); }
  }
  const owner = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink()
    || owner !== undefined && info.uid !== owner) return fail();
  let handle;
  try {
    handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.chmod(0o700);
    info = await handle.stat();
  } catch { return fail(); }
  finally { await handle?.close().catch(() => undefined); }
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700
    || owner !== undefined && info.uid !== owner) return fail();
  return root;
};
const isWithin = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);
const prepareExplicitContainerBundleRoot = async (
  raw: unknown,
  lifecycleRoot: string
): Promise<string> => {
  const requested = exactPath(raw);
  if (path.parse(requested).root === requested
    || isWithin(requested, lifecycleRoot)
    || isWithin(lifecycleRoot, requested)) return fail();
  try {
    const existing = await lstat(requested);
    if (!existing.isDirectory() || existing.isSymbolicLink()
      || await realpath(requested) !== requested) return fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
    const parent = path.dirname(requested);
    let parentInfo;
    try { parentInfo = await lstat(parent); } catch { return fail(); }
    const owner = process.getuid?.();
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
      || owner !== undefined && parentInfo.uid !== owner) return fail();
    try {
      if (await realpath(parent) !== parent) return fail();
    } catch { return fail(); }
  }
  const root = await ensureOwnedRoot(requested);
  try {
    if (await realpath(root) !== root) return fail();
  } catch { return fail(); }
  return root;
};
const prepareRoots = async (
  containerBundleStoreRoot: unknown
): Promise<TargetDefaultConfig["paths"]> => {
  const home = resolveSpawnfileHome();
  let homeInfo;
  try { homeInfo = await lstat(home); } catch { return fail(); }
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) return fail();
  const owner = process.getuid?.();
  if (owner !== undefined && homeInfo.uid !== owner) return fail();
  try {
    if (await realpath(home) !== home) return fail();
  } catch { return fail(); }
  const root = await ensureOwnedRoot(path.join(home, "target"));
  const childRoots = containerBundleStoreRoot === undefined
    ? [...CHILD_ROOTS, "container-bundles"] as const
    : CHILD_ROOTS;
  const created = await Promise.all(childRoots.map((name) =>
    ensureOwnedRoot(path.join(root, name))));
  const containerBundles = containerBundleStoreRoot === undefined
    ? created[6]!
    : await prepareExplicitContainerBundleRoot(containerBundleStoreRoot, root);
  return Object.freeze({
    root,
    journals: created[0]!,
    artifactIdentities: created[1]!,
    secretAuthority: created[2]!,
    attachmentAuthority: created[3]!,
    worldAuthority: created[4]!,
    evidenceExport: created[5]!,
    containerBundles
  });
};
const validateDestination = async (raw: unknown): Promise<string> => {
  const destination = exactPath(raw);
  const parent = path.dirname(destination);
  let parentInfo;
  try { parentInfo = await lstat(parent); } catch { return fail(); }
  const owner = process.getuid?.();
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
    || (parentInfo.mode & 0o777) !== 0o700
    || owner !== undefined && parentInfo.uid !== owner) return fail();
  try {
    if (await realpath(parent) !== parent) return fail();
  } catch { return fail(); }
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink()
      || owner !== undefined && existing.uid !== owner
      || (existing.mode & 0o777) !== 0o600) return fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
  }
  return destination;
};

export const loadTargetDefaultConfig = async (
  raw: TargetDefaultConfigInputs
): Promise<TargetDefaultConfig> => {
  const value = descriptorValues(raw);
  if (typeof value.context !== "string" || !CONTEXT.test(value.context)
    || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1
    || (value.timeoutMs as number) > 120_000
    || (Object.hasOwn(value, "artifactMappings") !== Object.hasOwn(value, "helperArtifactManifestDigest"))
    || (Object.hasOwn(value, "helperArtifactManifestDigest") &&
      (typeof value.helperArtifactManifestDigest !== "string"
        || !DIGEST.test(value.helperArtifactManifestDigest)))) return fail();
  const dockerCommand = command(value.dockerCommand);
  let artifactMappings: readonly DockerArtifactMapping[];
  try { artifactMappings = value.artifactMappings === undefined
    ? Object.freeze([]) : parseDockerArtifactMappings(value.artifactMappings); }
  catch { return fail(); }
  const preparedArtifactMappings = parseTargetPreparedArtifactMappings(
    value.preparedArtifactMappings
  );
  if (preparedArtifactMappings.some((prepared) => artifactMappings.some((artifact) =>
    artifact.artifact_manifest_digest === prepared.artifact_manifest_digest))) return fail();
  const evidenceDestination = await validateDestination(value.evidenceDestination);
  const matches = value.helperArtifactManifestDigest === undefined ? [] : artifactMappings.filter((mapping) =>
    mapping.artifact_manifest_digest === value.helperArtifactManifestDigest);
  if (value.helperArtifactManifestDigest !== undefined && matches.length !== 1) return fail();
  const paths = await prepareRoots(value.containerBundleStoreRoot);
  const config = {
    artifactMappings,
    context: value.context,
    dockerCommand,
    evidenceDestination,
    ...(matches.length === 1 ? { helperArtifact: matches[0]! } : {}),
    preparedArtifactMappings,
    paths,
    timeoutMs: value.timeoutMs as number
  };
  return Object.freeze(config);
};

/** Resolves only the paths required by a world-readiness query; performs no I/O. */
export const resolveTargetDefaultWorldReadinessConfig = (
  raw: TargetDefaultConfigInputs
): TargetDefaultWorldReadinessConfig => {
  const value = descriptorValues(raw);
  if (typeof value.context !== "string" || !CONTEXT.test(value.context)
    || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1
    || (value.timeoutMs as number) > 120_000) return fail();
  const home = resolveSpawnfileHome();
  return Object.freeze({
    context: value.context,
    dockerCommand: command(value.dockerCommand),
    paths: Object.freeze({
      worldAuthority: path.join(home, "target", "world-authority")
    }),
    timeoutMs: value.timeoutMs as number
  });
};
