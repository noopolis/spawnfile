import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { parseEnvFile } from "../auth/index.js";
import type { ImportedAuthKind, ResolvedAuthProfile } from "../auth/index.js";
import {
  fileExists,
  readUtf8File
} from "../filesystem/index.js";
import type { ContainerReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import {
  CLI_CREDENTIAL_SECRET_NAME,
  modelAuthMethodNeedsCliCredential
} from "./modelEnv.js";

interface PreparedRunAuth {
  coveredModelSecrets: Set<string>;
  mountArgs: string[];
}

const MODEL_AUTH_IMPORT_KINDS: Record<string, ImportedAuthKind | null> = {
  api_key: null,
  "claude-code": "claude-code",
  codex: "codex",
  none: null
};

export const resolveHostCliCredential = async (
  containerReport: ContainerReport
): Promise<{ name: string; sourcePath: string; value: string } | null> => {
  const needsCredential = containerReport.runtime_instances.some((instance) =>
    Object.values(instance.model_auth_methods).some(modelAuthMethodNeedsCliCredential)
  );
  if (!needsCredential) {
    return null;
  }

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sourcePath = path.join(codexHome, "auth.json");
  if (!await fileExists(sourcePath)) {
    throw new SpawnfileError(
      "validation_error",
      `Missing ${CLI_CREDENTIAL_SECRET_NAME}; host CLI credential source does not exist: ${sourcePath}`
    );
  }

  let value: string;
  try {
    value = await readUtf8File(sourcePath);
  } catch (error) {
    throw new SpawnfileError(
      "validation_error",
      `Unable to read ${CLI_CREDENTIAL_SECRET_NAME} from host CLI credential source ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (value.trim().length === 0) {
    throw new SpawnfileError(
      "validation_error",
      `Missing ${CLI_CREDENTIAL_SECRET_NAME}; host CLI credential source is empty: ${sourcePath}`
    );
  }

  try {
    return { name: CLI_CREDENTIAL_SECRET_NAME, sourcePath, value: JSON.stringify(JSON.parse(value)) };
  } catch (error) {
    throw new SpawnfileError(
      "validation_error",
      `Unable to read ${CLI_CREDENTIAL_SECRET_NAME} from host CLI credential source ${sourcePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
};

const addCoveredModelSecrets = (
  coveredModelSecrets: Set<string>,
  instanceId: string,
  secretNames: string[]
): void => {
  for (const secretName of secretNames) {
    coveredModelSecrets.add(`${instanceId}:${secretName}`);
  }
};

export const prepareRuntimeAuthMounts = async (
  outputDirectory: string,
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null,
  env: Record<string, string>,
  tempRoot: string
): Promise<PreparedRunAuth> => {
  // No early return when `authProfile` is null: an adapter's
  // `prepareRuntimeAuth` may still have host-credential staging to do that
  // does not depend on an imported Spawnfile auth profile (e.g. the Pi
  // adapter mounting the host's `~/.grok`/`~/.codex`/antigravity CLI homes
  // for a real-engine org — see `src/runtime/pi/runAuth.ts`). Each adapter is
  // responsible for treating a `null` `authProfile` as "no profile-derived
  // imports available" rather than failing.
  const coveredModelSecrets = new Set<string>();
  const mountArgs: string[] = [];

  for (const instance of containerReport.runtime_instances) {
    const adapter = getRuntimeAdapter(instance.runtime);
    if (!adapter.prepareRuntimeAuth) {
      continue;
    }

    const prepared = await adapter.prepareRuntimeAuth({
      authProfile,
      env,
      instance,
      outputDirectory,
      tempRoot
    });

    addCoveredModelSecrets(coveredModelSecrets, instance.id, prepared.coveredModelSecrets);
    mountArgs.push(...prepared.mountArgs);
  }

  return { coveredModelSecrets, mountArgs };
};

export const assertDeclaredModelAuthSatisfied = (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null,
  cliCredentialProvided = false
): void => {
  const requiredImportKinds = new Set<ImportedAuthKind>();

  for (const instance of containerReport.runtime_instances) {
    for (const method of Object.values(instance.model_auth_methods)) {
      const importKind = MODEL_AUTH_IMPORT_KINDS[method];
      if (importKind) {
        requiredImportKinds.add(importKind);
      }
    }
  }

  if (requiredImportKinds.size === 0) {
    return;
  }

  if (!authProfile && !cliCredentialProvided) {
    throw new SpawnfileError(
      "validation_error",
      `Auth profile is required for declared model auth methods: ${[...requiredImportKinds].sort().join(", ")}`
    );
  }

  if (cliCredentialProvided) {
    return;
  }

  if (!authProfile) {
    return;
  }

  const missingImportKinds = [...requiredImportKinds]
    .filter((kind) => !authProfile.imports[kind])
    .sort();
  if (missingImportKinds.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Auth profile ${authProfile.name} is missing required auth imports: ${missingImportKinds.join(", ")}`
    );
  }
};

const getImportMountTargetName = (kind: keyof ResolvedAuthProfile["imports"]): string =>
  kind === "claude-code" ? ".claude" : ".codex";

const createGeneratedRuntimeSecret = (
  secretName: string,
  generatedMoltnetSecrets: Set<string>
): string | null => {
  if (secretName === "OPENCLAW_GATEWAY_TOKEN" || secretName === "OPENCLAW_HOOKS_TOKEN") {
    return randomBytes(24).toString("hex");
  }
  if (generatedMoltnetSecrets.has(secretName)) {
    return randomBytes(32).toString("base64url");
  }

  return null;
};

const hasEnvValue = (env: Record<string, string>, name: string): boolean =>
  typeof env[name] === "string" && env[name]!.length > 0;

const collectMissingRequiredSecrets = (
  containerReport: ContainerReport,
  env: Record<string, string>,
  coveredModelSecrets: Set<string>
): string[] => {
  const missing = new Set<string>();

  for (const secretName of containerReport.secrets_required) {
    if (hasEnvValue(env, secretName)) {
      continue;
    }

    if (!containerReport.model_secrets_required.includes(secretName)) {
      missing.add(secretName);
      continue;
    }

    const requiredInstances = (containerReport.runtime_instances ?? []).filter((instance) =>
      instance.model_secrets_required.includes(secretName)
    );
    const isCoveredEverywhere =
      requiredInstances.length > 0 &&
      requiredInstances.every((instance) => coveredModelSecrets.has(`${instance.id}:${secretName}`));

    if (!isCoveredEverywhere) {
      missing.add(secretName);
    }
  }

  return [...missing].sort();
};

export const resolveRunEnvironment = (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null,
  envFileEnv: Record<string, string> = {}
): Record<string, string> => {
  const env: Record<string, string> = {
    ...(authProfile?.env ?? {}),
    ...envFileEnv
  };
  const generatedMoltnetSecrets = new Set(
    (containerReport.moltnet?.server_plans ?? [])
      .filter((server) => server.mode === "managed" && server.auth_mode === "bearer")
      .flatMap((server) => (server.auth_tokens ?? []).map((token) => token.secret))
  );

  for (const name of new Set([...Object.keys(env), ...containerReport.secrets_required])) {
    const processValue = process.env[name];
    if (typeof processValue === "string" && processValue.length > 0) {
      env[name] = processValue;
    }
  }

  for (const name of new Set([
    ...containerReport.runtime_secrets_required,
    ...generatedMoltnetSecrets
  ])) {
    if (hasEnvValue(env, name)) {
      continue;
    }

    const generatedValue = createGeneratedRuntimeSecret(name, generatedMoltnetSecrets);
    if (generatedValue) {
      env[name] = generatedValue;
    }
  }

  for (const [name, value] of Object.entries(env)) {
    if (value.includes("\n")) {
      throw new SpawnfileError(
        "validation_error",
        `Env value for ${name} contains a newline and cannot be written to a Docker env file`
      );
    }
  }

  return env;
};

export const assertRunEnvironmentSatisfied = (
  containerReport: ContainerReport,
  env: Record<string, string>,
  coveredModelSecrets: Set<string>
): void => {
  const missing = collectMissingRequiredSecrets(containerReport, env, coveredModelSecrets);
  if (missing.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Missing required runtime env: ${missing.sort().join(", ")}`
    );
  }
};

export const assertMoltnetCredentialValuesDistinct = (
  containerReport: ContainerReport,
  env: Record<string, string>
): void => {
  for (const server of containerReport.moltnet?.server_plans ?? []) {
    if (server.mode !== "managed" || server.auth_mode !== "bearer") {
      continue;
    }
    const secretNames = (server.auth_tokens ?? []).map((token) => token.secret);
    const normalizedValues = secretNames.map((name) => {
      const value = env[name];
      if (typeof value !== "string" || value.trim().length === 0) {
        return null;
      }
      if (value !== value.trim()) {
        throw new SpawnfileError(
          "validation_error",
          `Moltnet credential ${name} must not contain leading or trailing whitespace`
        );
      }
      return value;
    }).filter((value): value is string => value !== null);
    if (new Set(normalizedValues).size !== normalizedValues.length) {
      throw new SpawnfileError(
        "validation_error",
        `Moltnet network ${server.network_id} requires distinct credential values`
      );
    }
  }
};

export const renderDockerEnvFile = (env: Record<string, string>): string =>
  `${Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;

export const readRunEnvFile = async (
  envFilePath: string | undefined
): Promise<Record<string, string>> => {
  if (!envFilePath) {
    return {};
  }

  try {
    return parseEnvFile(await readUtf8File(envFilePath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "validation_error",
      `Unable to read env file ${envFilePath}: ${reason}`
    );
  }
};

export const resolveAuthMountArgs = async (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null
): Promise<string[]> => {
  if (!authProfile || containerReport.runtime_homes.length === 0) {
    return [];
  }

  const args: string[] = [];
  // Pi owns its model and CLI-engine auth projection in preparePiRuntimeAuth.
  // Mounting the generic imported home onto the same destination would create
  // duplicate Docker mount points and bypass the adapter's minimal-file staging.
  const piRuntimeHomes = new Set(
    containerReport.runtime_instances
      .filter((instance) => instance.runtime === "pi" || instance.runtime === "daimon")
      .map((instance) => instance.home_path)
      .filter((homePath): homePath is string => homePath !== null)
  );
  const genericRuntimeHomes = containerReport.runtime_homes
    .filter((runtimeHome) => !piRuntimeHomes.has(runtimeHome));

  for (const [kind, entry] of Object.entries(authProfile.imports) as Array<
    [
      keyof ResolvedAuthProfile["imports"],
      ResolvedAuthProfile["imports"][keyof ResolvedAuthProfile["imports"]]
    ]
  >) {
    if (!entry) {
      continue;
    }
    if (!(await fileExists(entry.path))) {
      throw new SpawnfileError(
        "validation_error",
        `Imported auth path for ${kind} does not exist: ${entry.path}`
      );
    }

    for (const runtimeHome of genericRuntimeHomes) {
      args.push("-v", `${entry.path}:${path.posix.join(runtimeHome, getImportMountTargetName(kind))}`);
    }
  }

  return args;
};
