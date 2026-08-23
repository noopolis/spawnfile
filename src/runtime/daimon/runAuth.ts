import os from "node:os";
import path from "node:path";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";

import { SpawnfileError } from "../../shared/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

import {
  DAIMON_AGY_SUBSCRIPTION_REALM,
  assertDaimonRuntimeHome,
  DAIMON_ENGINE_CREDENTIALS,
  DAIMON_ENGINE_KINDS,
  type DaimonEngine
} from "./contractManifest.js";

const MAX_OPAQUE_CREDENTIAL_BYTES = 64 * 1024;
export const DAIMON_AGY_UNLOCK_SOURCE_ENV = "SPAWNFILE_DAIMON_SOURCE_AGY_UNLOCK_SECRET";

interface DaimonConfigAgent {
  engine: { kind: DaimonEngine };
  id: string;
  runtimeHomePath: string;
}

const DAIMON_CONFIG_VERSION = "noopolis.daimon.organization-runtime.v1";

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", `Daimon runtime auth ${message}`);
};

const sourceEnvironmentName = (slot: string): string =>
  `SPAWNFILE_DAIMON_SOURCE_${slot.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;

const sourcePathForEngine = (engine: Exclude<DaimonEngine, "agy">): string => {
  const declaredSource = process.env[
    sourceEnvironmentName(DAIMON_ENGINE_CREDENTIALS[engine].sourceSlot)
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

const assertSafeSourceFile = async (
  sourcePath: string,
  label: string,
  maxBytes = MAX_OPAQUE_CREDENTIAL_BYTES
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
  return callerUid;
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
  if (root.version !== DAIMON_CONFIG_VERSION || !Array.isArray(root.agents)) fail("generated organization config is not v1");
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
  agent: DaimonConfigAgent & { engine: { kind: Exclude<DaimonEngine, "agy"> } }
): Promise<string> => {
  return sourcePathForEngine(agent.engine.kind);
};

const prepareNeutralIngress = async (
  outputDirectory: string,
  agent: DaimonConfigAgent & { engine: { kind: Exclude<DaimonEngine, "agy"> } }
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
 * Binds one declared credential leaf per Daimon agent without copying or
 * reading its contents. The read-only mount is a generic private ingress;
 * Daimon is solely responsible for consuming it into its runtime-owned home.
 */
export const prepareDaimonRuntimeAuth = async (
  input: RuntimeAuthPreparationInput
): Promise<RuntimeAuthPreparationResult> => {
  const allowedSourceEnvironments = new Set([
    ...Object.values(DAIMON_ENGINE_CREDENTIALS).map((credential) =>
      sourceEnvironmentName(credential.sourceSlot)
    ),
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
  let authorizedUid: number | undefined;
  for (const agent of agents) {
    if (agent.engine.kind === "agy") continue;
    const portableAgent = agent as DaimonConfigAgent & {
      engine: { kind: Exclude<DaimonEngine, "agy"> };
    };
    const sourcePath = await resolveCredentialSource(portableAgent);
    const ingressPath = await prepareNeutralIngress(input.outputDirectory, portableAgent);
    const sourceUid = await assertSafeSourceFile(sourcePath, agent.engine.kind);
    if (authorizedUid !== undefined && sourceUid !== authorizedUid) {
      return fail("selected credential artifacts must share one authorized UID");
    }
    authorizedUid = sourceUid;
    mountArgs.push("-v", `${sourcePath}:${ingressPath}:ro`);
  }
  if (agents.some((agent) => agent.engine.kind === "agy")) {
    const source = process.env[DAIMON_AGY_UNLOCK_SOURCE_ENV]?.trim();
    if (!source) return fail("is missing the operator-authorized AGY realm unlock artifact");
    const sourceUid = await assertSafeSourceFile(
      source,
      "AGY realm unlock",
      DAIMON_AGY_SUBSCRIPTION_REALM.maxUnlockBytes
    );
    if (authorizedUid !== undefined && sourceUid !== authorizedUid) {
      return fail("selected credential artifacts must share one authorized UID");
    }
    authorizedUid = sourceUid;
    mountArgs.push("-v", `${source}:${DAIMON_AGY_SUBSCRIPTION_REALM.unlockMountPath}:ro`);
  }
  return {
    coveredModelSecrets: [],
    ...(authorizedUid === undefined ? {} : {
      launchIdentity: { kind: "daimon" as const, uid: authorizedUid }
    }),
    mountArgs
  };
};
