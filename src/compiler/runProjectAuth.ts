import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createLoginVolumeReservation } from "../runtime/nativeLogin.js";

import { parseEnvFile } from "../auth/index.js";
import type { ImportedAuthKind, ResolvedAuthProfile } from "../auth/index.js";
import {
  fileExists,
  readUtf8File
} from "../filesystem/index.js";
import type { ContainerReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import { prepareRuntimeHomeImports, requestsRuntimeHomeImport, resolveRuntimeHomeImports, type RuntimeHomeImport } from "../runtime/runtimeHomeImports.js";
import { adapterManagedAuthMethods, selectRuntimeGeneratedSecrets } from "../runtime/hostSelection.js";
import type { RuntimeAuthPreparationResult, RuntimeHomeAuthMethod } from "../runtime/types.js";
import {
  CLI_CREDENTIAL_SECRET_NAME,
  modelAuthMethodNeedsCliCredential
} from "./modelEnv.js";

interface PreparedRunAuth {
  coveredModelSecrets: Set<string>;
  launchIdentity?: RuntimeAuthPreparationResult["launchIdentity"];
  credentialRuntime?: string;
  mountArgs: string[];
}

const MODEL_AUTH_IMPORT_KINDS: Record<string, ImportedAuthKind | null> = {
  api_key: null,
  "claude-code": "claude-code",
  codex: "codex",
  none: null
};

export const resolveHostCliCredential = async (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null = null
): Promise<{ name: string; sourcePath: string; value: string } | null> => {
  if (!containerReport.runtime_instances.some((instance) => uncoveredCliMethods(instance, []).length > 0)) {
    return null;
  }
  const imports = resolveRuntimeHomeImports(containerReport.runtime_instances, authProfile);
  const needsCredential = containerReport.runtime_instances.some((instance) =>
    uncoveredCliMethods(instance, imports).length > 0
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

const uncoveredCliMethods = (
  instance: ContainerReport["runtime_instances"][number], imports: RuntimeHomeImport[]
): RuntimeHomeAuthMethod[] => Object.values(instance.model_auth_methods).filter(
  (method): method is RuntimeHomeAuthMethod =>
    (method === "codex" || method === "claude-code") &&
    modelAuthMethodNeedsCliCredential(method, adapterManagedAuthMethods(instance.runtime)) &&
    !(requestsRuntimeHomeImport(instance, method) && imports.some((imported) => imported.method === method))
);

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
  tempRoot: string,
  containerCredentialUid?: number
): Promise<PreparedRunAuth> => {
  // Adapters receive null profiles so they can handle runtime-owned credentials.
  const reserveLoginVolume = createLoginVolumeReservation();
  const coveredModelSecrets = new Set<string>();
  let launchIdentity: RuntimeAuthPreparationResult["launchIdentity"];
  let credentialRuntime: string | undefined;
  const mountArgs: string[] = [];

  for (const instance of containerReport.runtime_instances) {
    const adapter = getRuntimeAdapter(instance.runtime);
    if (!adapter.prepareRuntimeAuth) {
      continue;
    }

    const prepared = await adapter.prepareRuntimeAuth({
      authProfile,
      reserveLoginVolume,
      ...(containerCredentialUid === undefined ? {} : { containerCredentialUid }),
      env,
      instance,
      outputDirectory,
      tempRoot
    });

    addCoveredModelSecrets(coveredModelSecrets, instance.id, prepared.coveredModelSecrets);
    if (prepared.launchIdentity) {
      if (launchIdentity && (launchIdentity.uid !== prepared.launchIdentity.uid || credentialRuntime !== instance.runtime)) {
        throw new SpawnfileError(
          "validation_error",
          "Opaque runtime credentials resolve conflicting launch UIDs"
        );
      }
      launchIdentity = prepared.launchIdentity;
      credentialRuntime = instance.runtime;
    }
    mountArgs.push(...prepared.mountArgs);
  }

  return {
    coveredModelSecrets,
    ...(launchIdentity ? { launchIdentity, credentialRuntime } : {}),
    mountArgs
  };
};

export const assertDeclaredModelAuthSatisfied = (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null,
  cliCredentialProvided = false
): void => {
  const requiredImportKinds = new Set<ImportedAuthKind>();

  for (const instance of containerReport.runtime_instances) {
    for (const method of Object.values(instance.model_auth_methods)) {
      if (adapterManagedAuthMethods(instance.runtime)?.includes(method)) continue;
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

  const generatedRuntimeSecrets = selectRuntimeGeneratedSecrets(containerReport.runtime_instances.map((instance) => instance.runtime));
  for (const name of new Set([
    ...containerReport.runtime_secrets_required,
    ...generatedMoltnetSecrets
  ])) {
    if (hasEnvValue(env, name)) {
      continue;
    }

    const policy = generatedRuntimeSecrets.get(name);
    if (policy) {
      env[name] = randomBytes(policy.bytes).toString(policy.encoding);
    } else if (generatedMoltnetSecrets.has(name)) {
      env[name] = randomBytes(32).toString("base64url");
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

export const prepareRunHomeAuth = async (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null,
  env: Record<string, string>
): Promise<Pick<PreparedRunAuth, "coveredModelSecrets" | "mountArgs">> => {
  assertDeclaredModelAuthSatisfied(containerReport, authProfile, hasEnvValue(env, CLI_CREDENTIAL_SECRET_NAME));
  const { imports, mountArgs } = await prepareRuntimeHomeImports(containerReport.runtime_instances, authProfile);
  const coveredModelSecrets = new Set<string>();
  for (const instance of containerReport.runtime_instances) {
    if (instance.model_secrets_required.includes(CLI_CREDENTIAL_SECRET_NAME) &&
        imports.some(({ method }) => requestsRuntimeHomeImport(instance, method)) &&
        uncoveredCliMethods(instance, imports).length === 0) {
      addCoveredModelSecrets(coveredModelSecrets, instance.id, [CLI_CREDENTIAL_SECRET_NAME]);
    }
  }
  return { coveredModelSecrets, mountArgs };
};
