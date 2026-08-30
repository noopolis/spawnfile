import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";

import { SpawnfileError } from "../../shared/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

import {
  DAIMON_AGY_SUBSCRIPTION_REALM,
  assertDaimonRuntimeHome,
  DAIMON_ENGINE_CREDENTIALS,
  DAIMON_ENGINE_KINDS,
  DAIMON_GROK_SUBSCRIPTION_REALM,
  DAIMON_ORGANIZATION_RUNTIME_CONFIG_VERSIONS,
  type DaimonEngine
} from "./contractManifest.js";

const MAX_OPAQUE_CREDENTIAL_BYTES = 64 * 1024;
export const DAIMON_GROK_ACCESS_TOKEN_MIN_BYTES = 32;
export const DAIMON_GROK_REFRESH_TOKEN_MIN_BYTES = 16;
export const DAIMON_AGY_UNLOCK_SOURCE_ENV = "SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET";

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

export const daimonSourcePathForEngine = (
  engine: "codex" | "grok",
  environment: Record<string, string | undefined> = process.env
): string => {
  const declaredSource = environment[
    daimonSourceEnvironmentName(engine === "grok"
      ? DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapSourceSlot
      : DAIMON_ENGINE_CREDENTIALS.codex.sourceSlot)
  ]?.trim();
  if (declaredSource) return declaredSource;
  const home = os.homedir();
  switch (engine) {
    case "codex":
      return path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "auth.json");
    case "grok":
      return path.join(process.env.GROK_HOME || path.join(home, ".grok"), "auth.json");
  }
};

const sourceFileIdentity = (entry: Awaited<ReturnType<typeof lstat>>): string =>
  [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.uid, entry.mode, entry.nlink].join(":");

export const assertSafeDaimonSourceFile = async (
  sourcePath: string,
  label: string,
  maxBytes = MAX_OPAQUE_CREDENTIAL_BYTES,
  portableKind?: "codex" | "grok"
): Promise<number> => {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(sourcePath);
  } catch {
    return fail(`is missing the selected ${label} artifact`);
  }
  const callerUid = process.getuid?.();
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size === 0 ||
    entry.size > maxBytes ||
    entry.nlink !== 1 ||
    (entry.mode & 0o777) !== 0o600 ||
    typeof callerUid !== "number" ||
    callerUid <= 0 ||
    entry.uid !== callerUid
  ) {
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

const hasRefreshableCredential = (kind: "codex" | "grok", bytes: Buffer): boolean => {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const root = parsed as Record<string, unknown>;
  const source = kind === "codex"
    ? ((root.tokens && typeof root.tokens === "object" && !Array.isArray(root.tokens)) ? root.tokens as Record<string, unknown> : root)
    : Object.entries(root).find(([key, value]) => /^https:\/\/auth\.x\.ai::/u.test(key) && value && typeof value === "object" && !Array.isArray(value))?.[1] as Record<string, unknown> | undefined;
  if (!source) return false;
  const access = kind === "grok" ? source.key : source.access_token ?? source.accessToken ?? source.token;
  const refresh = kind === "grok" ? source.refresh_token : source.refresh_token ?? source.refreshToken;
  if (typeof access !== "string" || !access.trim() || typeof refresh !== "string" || !refresh.trim()) return false;
  if (kind === "grok" && (access.length < DAIMON_GROK_ACCESS_TOKEN_MIN_BYTES
    || refresh.length < DAIMON_GROK_REFRESH_TOKEN_MIN_BYTES)) return false;
  return kind !== "grok" || (typeof source.expires_at === "string" && Number.isFinite(Date.parse(source.expires_at)));
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
      || !(DAIMON_ENGINE_KINDS as readonly string[]).includes(engineKind)) {
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

const resolveCredentialSource = async (
  agent: DaimonConfigAgent & { engine: { kind: "codex" } }
): Promise<string> => {
  return daimonSourcePathForEngine(agent.engine.kind);
};

const prepareNeutralIngress = async (
  outputDirectory: string,
  agent: DaimonConfigAgent & { engine: { kind: "codex" } }
): Promise<string> => {
  const rootfs = path.join(outputDirectory, "container", "rootfs");
  const runtimeHome = assertContainedPath(rootfs, path.join(rootfs, `.${agent.runtimeHomePath}`));
  const inbound = assertContainedPath(
    runtimeHome,
    path.join(runtimeHome, path.posix.dirname(DAIMON_ENGINE_CREDENTIALS[agent.engine.kind].sourceRelativePath))
  );
  await mkdir(runtimeHome, { mode: 0o700, recursive: true });
  await chmod(runtimeHome, 0o700);
  await mkdir(inbound, { mode: 0o700, recursive: true });
  await chmod(inbound, 0o700);
  return path.posix.join(agent.runtimeHomePath, DAIMON_ENGINE_CREDENTIALS[agent.engine.kind].sourceRelativePath);
};

/**
 * Binds Codex leaves per agent and one Grok bootstrap leaf per organization.
 * Every leaf is validated from a stable descriptor and mounted read-only;
 * Daimon alone owns writable credential state and refresh reconciliation.
 */
export const prepareDaimonRuntimeAuth = async (
  input: RuntimeAuthPreparationInput
): Promise<RuntimeAuthPreparationResult> => {
  const allowedSourceEnvironments = new Set([
    ...Object.values(DAIMON_ENGINE_CREDENTIALS).map((credential) =>
      daimonSourceEnvironmentName(credential.sourceSlot)
    ),
    daimonSourceEnvironmentName(DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapSourceSlot),
    DAIMON_AGY_UNLOCK_SOURCE_ENV
  ]);
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
    if (agent.engine.kind !== "codex") continue;
    const portableAgent = agent as DaimonConfigAgent & {
      engine: { kind: "codex" };
    };
    const sourcePath = await resolveCredentialSource(portableAgent);
    const ingressPath = await prepareNeutralIngress(input.outputDirectory, portableAgent);
    await assertSafeDaimonSourceFile(sourcePath, agent.engine.kind, MAX_OPAQUE_CREDENTIAL_BYTES, "codex");
    mountArgs.push("-v", `${sourcePath}:${ingressPath}:ro`);
  }
  if (agents.some((agent) => agent.engine.kind === "grok")) {
    const sourcePath = daimonSourcePathForEngine("grok");
    await assertSafeDaimonSourceFile(
      sourcePath, "grok", DAIMON_GROK_SUBSCRIPTION_REALM.maxCredentialBytes, "grok"
    );
    mountArgs.push("-v", `${sourcePath}:${DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath}:ro`);
  }
  if (agents.some((agent) => agent.engine.kind === "agy")) {
    const source = process.env[DAIMON_AGY_UNLOCK_SOURCE_ENV]?.trim();
    if (!source) return fail("is missing the operator-authorized AGY realm unlock artifact");
    await assertSafeDaimonSourceFile(
      source,
      "AGY realm unlock",
      DAIMON_AGY_SUBSCRIPTION_REALM.maxUnlockBytes
    );
    mountArgs.push("-v", `${source}:${DAIMON_AGY_SUBSCRIPTION_REALM.unlockMountPath}:ro`);
  }
  return {
    coveredModelSecrets: [],
    mountArgs
  };
};
