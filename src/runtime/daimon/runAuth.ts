import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";

import { SpawnfileError } from "../../shared/index.js";
import type { ResolvedAuthProfile } from "../../auth/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

import {
  assertDaimonRuntimeHome,
  DAIMON_ORGANIZATION_RUNTIME_CONFIG_VERSIONS,
  type DaimonEngine
} from "./contractManifest.js";
import { DAIMON_ENGINE_DESCRIPTORS, DAIMON_ENGINES, DAIMON_PORTABLE_ENGINE_ID, DAIMON_SECRET_SERVICE_ENGINE_ID, getDaimonEngineDescriptor } from "./engines.js";
import type { DaimonEngineDescriptor } from "./engineDescriptorSchema.js";
import { DAIMON_ORGANIZATION_UID } from "./runtimeIdentity.js";

const MAX_OPAQUE_CREDENTIAL_BYTES = 64 * 1024;
export const DAIMON_GROK_ACCESS_TOKEN_MIN_BYTES = 32;
export const DAIMON_GROK_REFRESH_TOKEN_MIN_BYTES = 16;

interface DaimonConfigAgent {
  engine: { kind: DaimonEngine };
  id: string;
  runtimeHomePath: string;
}

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", `Daimon runtime auth ${message}`);
};

export const daimonSourceEnvironmentName = (slot: string): string =>
  `SPAWNFILE_DAIMON_SOURCE_${slot.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;

const descriptorForEngine = (engine: string) =>
  getDaimonEngineDescriptor(engine) ?? fail(`has an undeclared engine ${engine}`);

const sourceSlotForDescriptor = (descriptor: DaimonEngineDescriptor): string => {
  const engine = descriptor.id;
  if (descriptor.auth.staging === "portable-file") {
    return descriptor.credentialMaterial?.sourceSlot ?? fail(`engine ${engine} has no declared credential source slot`);
  }
  if (descriptor.auth.staging === "broker-realm" || descriptor.auth.staging === "portable-realm") return descriptor.auth.realm.bootstrapSourceSlot;
  return descriptor.auth.realm.unlockSourceSlot;
};

export const DAIMON_AGY_UNLOCK_SOURCE_ENV = daimonSourceEnvironmentName(
  sourceSlotForDescriptor(descriptorForEngine(DAIMON_SECRET_SERVICE_ENGINE_ID))
);

export const daimonSourcePathForEngine = (
  engine: string,
  environment: Record<string, string | undefined> = process.env,
  authProfile: ResolvedAuthProfile | null = null,
  descriptor: DaimonEngineDescriptor = descriptorForEngine(engine)
): string => {
  const declaredSource = environment[daimonSourceEnvironmentName(sourceSlotForDescriptor(descriptor))]?.trim();
  if (declaredSource) return declaredSource;
  if (descriptor.auth.staging === "secret-service") {
    return fail(`is missing the operator-authorized ${engine.toUpperCase()} realm unlock artifact`);
  }
  // Import selection is Spawnfile policy; realm credentials remain runtime-owned.
  if (engine === DAIMON_PORTABLE_ENGINE_ID && authProfile) {
    const imported = authProfile.imports[DAIMON_PORTABLE_ENGINE_ID as keyof typeof authProfile.imports];
    return path.join(
      imported?.path ?? fail(`selected auth profile has no imported ${engine} credential`),
      descriptor.auth.fileName
    );
  }
  return path.join(environment[descriptor.homeEnvironment] || path.join(os.homedir(), descriptor.homeDirectory), descriptor.auth.fileName);
};

const sourceFileIdentity = (entry: Awaited<ReturnType<typeof lstat>>): string =>
  [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.uid, entry.mode, entry.nlink].join(":");

/**
 * The uid a bind-mounted Daimon credential must be owned by on the host.
 *
 * Daimon compares the file's owner against its own `process.getuid()` inside
 * the container, the container runs as {@link DAIMON_ORGANIZATION_UID}, and a
 * read-only bind mount carries the host uid through unchanged, so the two are
 * the same number. See `runtimeIdentity.ts` for the full chain.
 */
export const DAIMON_CREDENTIAL_CONTAINER_UID = DAIMON_ORGANIZATION_UID;

export interface DaimonSourceFileFacts {
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  nlink: number;
  size: number;
  uid: number;
}

/**
 * The host-side safety gate, isolated from `lstat` so every branch is directly
 * exercisable. A credential the deploying process does not own is material it
 * cannot vouch for, and a root deploy (`callerUid <= 0`) is refused outright
 * so a privileged process never launders someone else's credential into a
 * container.
 */
export const isUnsafeDaimonSourceFile = (
  entry: DaimonSourceFileFacts,
  callerUid: number | undefined,
  maxBytes: number
): boolean =>
  !entry.isFile ||
  entry.isSymbolicLink ||
  entry.size === 0 ||
  entry.size > maxBytes ||
  entry.nlink !== 1 ||
  (entry.mode & 0o777) !== 0o600 ||
  typeof callerUid !== "number" ||
  callerUid <= 0 ||
  entry.uid !== callerUid;

/**
 * Refuses, at deploy time, a credential whose owner is not the uid the
 * container will demand.
 *
 * Without this the host gate above and Daimon's in-container gate impose two
 * uncoordinated uid requirements on the same file: the host one passes for any
 * non-root deploying account, and the container one then fails at readiness
 * with an opaque "credential materialization failed" inside a candidate that
 * lives ~15 seconds. Naming both numbers here turns that into a refusal the
 * operator can act on.
 */
export const assertDaimonCredentialContainerOwner = (
  observedUid: number,
  label: string,
  requiredUid: number = DAIMON_CREDENTIAL_CONTAINER_UID
): void => {
  if (observedUid === requiredUid) return;
  fail(
    `selected ${label} artifact is owned by uid ${observedUid} but the Daimon container reads it as uid ` +
    `${requiredUid}; the credential is bind-mounted read-only and keeps its host owner, so deploy from an ` +
    `account whose uid is exactly ${requiredUid} (for example \`usermod -u ${requiredUid} <deploy-user>\` ` +
    `followed by \`chown -R ${requiredUid} <deploy-home>\`) instead of uid ${observedUid}`
  );
};

export const assertSafeDaimonSourceFile = async (
  sourcePath: string,
  label: string,
  maxBytes = MAX_OPAQUE_CREDENTIAL_BYTES,
  portableKind?: string | DaimonEngineDescriptor
): Promise<number> => {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(sourcePath);
  } catch {
    return fail(`is missing the selected ${label} artifact`);
  }
  const callerUid = process.getuid?.();
  if (isUnsafeDaimonSourceFile({
    isFile: entry.isFile(),
    isSymbolicLink: entry.isSymbolicLink(),
    mode: entry.mode,
    nlink: entry.nlink,
    size: entry.size,
    uid: entry.uid
  }, callerUid, maxBytes) || typeof callerUid !== "number") {
    return fail(`selected ${label} artifact must be one bounded caller-owned 0600 regular file`);
  }
  if (portableKind !== undefined) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let bytes: Buffer | undefined;
    try {
      handle = await open(sourcePath, constants.O_RDONLY | ((constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (sourceFileIdentity(opened) !== sourceFileIdentity(entry)) {
        return fail(`selected ${label} artifact changed during validation`);
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (sourceFileIdentity(after) !== sourceFileIdentity(opened)) {
        return fail(`selected ${label} artifact changed during validation`);
      }
      if (!hasRefreshableCredential(portableKind, bytes)) {
        return fail(`selected ${label} artifact is not a refreshable subscription credential`);
      }
    } catch (error) {
      if (error instanceof SpawnfileError) throw error;
      return fail(`selected ${label} artifact could not be validated`);
    } finally {
      bytes?.fill(0);
      await handle?.close().catch(() => undefined);
    }
  }
  return callerUid;
};

const hasRefreshableCredential = (kind: string | DaimonEngineDescriptor, bytes: Buffer): boolean => {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const descriptor = typeof kind === "string" ? descriptorForEngine(kind) : kind;
  const format = descriptor.auth.format;
  if (!format) return false;
  const root = parsed as Record<string, unknown>;
  const container = format.containerKey ? root[format.containerKey] : undefined;
  const source = format.entryKeyPattern
    ? Object.entries(root).find(([key, value]) => new RegExp(format.entryKeyPattern!, "u").test(key) && value && typeof value === "object" && !Array.isArray(value))?.[1] as Record<string, unknown> | undefined
    : container && typeof container === "object" && !Array.isArray(container)
      ? container as Record<string, unknown> : format.fallbackToRoot ? root : undefined;
  if (!source) return false;
  const access = format.accessTokenKeys.map((key) => source[key]).find((value) => value !== null && value !== undefined);
  const refresh = format.refreshTokenKeys.map((key) => source[key]).find((value) => value !== null && value !== undefined);
  if (typeof access !== "string" || !access.trim() || typeof refresh !== "string" || !refresh.trim()) return false;
  // Compiler preflight retains the native broker's credential length boundary.
  if (descriptor.auth.staging === "broker-realm" && (access.length < DAIMON_GROK_ACCESS_TOKEN_MIN_BYTES
    || refresh.length < DAIMON_GROK_REFRESH_TOKEN_MIN_BYTES)) return false;
  const expires = format.expiresAtKey ? source[format.expiresAtKey] : undefined;
  return !format.expiresAtKey || (typeof expires === "string" && Number.isFinite(Date.parse(expires)));
};

const assertContainedPath = (root: string, candidate: string): string => {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return fail("attempted to stage outside its ephemeral support root");
  }
  return normalizedCandidate;
};

const configPathInOutput = (input: RuntimeAuthPreparationInput): string => {
  if (!input.instance.config_path.startsWith("/")) fail("has a non-absolute generated config path");
  return assertContainedPath(
    path.join(input.outputDirectory, "container", "rootfs"),
    path.join(input.outputDirectory, "container", "rootfs", `.${input.instance.config_path}`)
  );
};

const parseConfigAgents = (source: string): DaimonConfigAgent[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return fail("generated organization config is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("generated organization config has an invalid shape");
  const root = parsed as Record<string, unknown>;
  if (!(DAIMON_ORGANIZATION_RUNTIME_CONFIG_VERSIONS as readonly unknown[]).includes(root.version) || !Array.isArray(root.agents)) fail("generated organization config is not a supported v1/v2 contract");
  const rawAgents = root.agents as unknown[];
  const seenHomes = new Set<string>();
  const agents: DaimonConfigAgent[] = [];
  for (const value of rawAgents) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("generated organization config has an invalid agent");
    const agent = value as Record<string, unknown>;
    const engine = agent.engine;
    const engineKind = engine && typeof engine === "object" && !Array.isArray(engine)
      ? (engine as Record<string, unknown>).kind
      : undefined;
    if (typeof agent.id !== "string" || !agent.id || typeof agent.runtimeHomePath !== "string"
      || typeof engineKind !== "string"
      || !DAIMON_ENGINES.includes(engineKind)) {
      fail("generated organization config has an invalid agent credential target");
    }
    const agentId = agent.id as string;
    const runtimeHomePath = assertDaimonRuntimeHome(agent.runtimeHomePath as string);
    if (seenHomes.has(runtimeHomePath)) fail("generated organization config has overlapping runtime homes");
    seenHomes.add(runtimeHomePath);
    agents.push({
      engine: { kind: engineKind as DaimonEngine },
      id: agentId,
      runtimeHomePath
    });
  }
  return agents.sort((left, right) => left.id.localeCompare(right.id));
};

const prepareNeutralIngress = async (
  outputDirectory: string,
  agent: DaimonConfigAgent
): Promise<string> => {
  const credential = descriptorForEngine(agent.engine.kind).credentialMaterial;
  const sourceRelativePath = credential?.sourceRelativePath
    ?? fail(`engine ${agent.engine.kind} has no declared credential ingress path`);
  const rootfs = path.join(outputDirectory, "container", "rootfs");
  const runtimeHome = assertContainedPath(rootfs, path.join(rootfs, `.${agent.runtimeHomePath}`));
  const inbound = assertContainedPath(
    runtimeHome,
    path.join(runtimeHome, path.posix.dirname(sourceRelativePath))
  );
  await mkdir(runtimeHome, { mode: 0o700, recursive: true });
  await chmod(runtimeHome, 0o700);
  await mkdir(inbound, { mode: 0o700, recursive: true });
  await chmod(inbound, 0o700);
  return path.posix.join(agent.runtimeHomePath, sourceRelativePath);
};

/**
 * Binds portable leaves per agent and each declared realm once per organization.
 * Every leaf is validated from a stable descriptor and mounted read-only;
 * Daimon alone owns writable credential state and refresh reconciliation.
 */
export const prepareDaimonRuntimeAuth = async (
  input: RuntimeAuthPreparationInput
): Promise<RuntimeAuthPreparationResult> => {
  const containerCredentialUid = input.containerCredentialUid ?? DAIMON_CREDENTIAL_CONTAINER_UID;
  const allowedSourceEnvironments = new Set(Object.keys(DAIMON_ENGINE_DESCRIPTORS).map((engine) =>
    daimonSourceEnvironmentName(sourceSlotForDescriptor(descriptorForEngine(engine)))
  ));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("SPAWNFILE_DAIMON_SOURCE_") && !allowedSourceEnvironments.has(name)) {
      return fail(`source slot environment ${name} is not declared by the consumed manifest`);
    }
  }
  const configPath = configPathInOutput(input);
  let configSource: string;
  try {
    configSource = await readFile(configPath, "utf8");
  } catch {
    return fail("could not read its generated organization config");
  }
  const agents = parseConfigAgents(configSource);
  const mountArgs: string[] = [];
  for (const agent of agents) {
    const descriptor = descriptorForEngine(agent.engine.kind);
    if (descriptor.auth.staging !== "portable-file") continue;
    const sourcePath = daimonSourcePathForEngine(agent.engine.kind, process.env, input.authProfile);
    const ingressPath = await prepareNeutralIngress(input.outputDirectory, agent);
    const ownerUid = await assertSafeDaimonSourceFile(
      sourcePath, agent.engine.kind, descriptor.auth.maxCredentialBytes, agent.engine.kind
    );
    assertDaimonCredentialContainerOwner(ownerUid, agent.engine.kind, containerCredentialUid);
    mountArgs.push("-v", `${sourcePath}:${ingressPath}:ro`);
  }
  // Realm auth is staged once per organization, in the historical mount order.
  for (const staging of ["portable-realm", "broker-realm", "secret-service"] as const) {
    for (const engine of new Set(agents.map((agent) => agent.engine.kind))) {
      const descriptor = descriptorForEngine(engine);
      if (descriptor.auth.staging !== staging) continue;
      const source = daimonSourcePathForEngine(engine, process.env, input.authProfile);
      if (descriptor.auth.staging === "portable-realm") {
        const ownerUid = await assertSafeDaimonSourceFile(source, engine, descriptor.auth.maxCredentialBytes, engine);
        assertDaimonCredentialContainerOwner(ownerUid, engine, containerCredentialUid);
        mountArgs.push("-v", `${source}:${descriptor.auth.realm.bootstrapMountPath}:ro`);
      } else if (descriptor.auth.staging === "broker-realm") {
        const realm = descriptor.auth.realm;
        // The organization uid never reads broker bootstrap material.
        await assertSafeDaimonSourceFile(source, engine, descriptor.auth.maxCredentialBytes, engine);
        mountArgs.push("-v", `${source}:${realm.bootstrapMountPath}:ro`);
      } else if (descriptor.auth.staging === "secret-service") {
        const realm = descriptor.auth.realm;
        const label = `${engine.toUpperCase()} realm unlock`;
        const ownerUid = await assertSafeDaimonSourceFile(source, label, realm.maxUnlockBytes);
        assertDaimonCredentialContainerOwner(ownerUid, label, containerCredentialUid);
        mountArgs.push("-v", `${source}:${realm.unlockMountPath}:ro`);
      }
    }
  }
  return {
    coveredModelSecrets: [],
    mountArgs
  };
};
