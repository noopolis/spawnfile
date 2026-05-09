import {
  ensureAuthProfile,
  importClaudeCodeAuth,
  importCodexAuth,
  parseEnvFile,
  requireAuthProfile,
  setAuthProfileEnv
} from "../auth/index.js";
import { readUtf8File } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import { listAgentSurfaceSecretNames } from "./agentSurfaces.js";
import { buildCompilePlan } from "./buildCompilePlan.js";
import { listMoltnetNetworkSecretNames } from "./compilePlanHelpers.js";
import {
  listExecutionModelSecretNames,
  resolveExecutionModelAuthMethods
} from "./modelEnv.js";

export interface SyncProjectAuthOptions {
  claudeCodeDirectory?: string;
  codexDirectory?: string;
  envFilePath?: string;
  profileName: string;
}

const resolveAuthRequirements = async (
  inputPath: string
): Promise<{
  methods: Set<"api_key" | "claude-code" | "codex" | "none">;
  optionalEnvNames: Set<string>;
  requiredEnvNames: Set<string>;
}> => {
  const plan = await buildCompilePlan(inputPath);
  const methods = new Set<"api_key" | "claude-code" | "codex" | "none">();
  const optionalEnvNames = new Set<string>();
  const requiredEnvNames = new Set<string>();

  const addProjectSecret = (secret: { name: string; required: boolean }): void => {
    if (secret.required) {
      requiredEnvNames.add(secret.name);
      optionalEnvNames.delete(secret.name);
    } else if (!requiredEnvNames.has(secret.name)) {
      optionalEnvNames.add(secret.name);
    }
  };

  for (const node of plan.nodes) {
    if (node.value.kind !== "agent") {
      for (const secret of node.value.shared.secrets) {
        addProjectSecret(secret);
      }
      for (const server of node.value.shared.mcpServers) {
        if (server.auth?.secret) {
          addProjectSecret({ name: server.auth.secret, required: true });
        }
      }
      for (const secretName of listMoltnetNetworkSecretNames([node])) {
        addProjectSecret({ name: secretName, required: true });
      }
      continue;
    }

    for (const secret of node.value.secrets) {
      addProjectSecret(secret);
    }

    for (const server of node.value.mcpServers) {
      if (server.auth?.secret) {
        addProjectSecret({ name: server.auth.secret, required: true });
      }
    }

    for (const method of Object.values(resolveExecutionModelAuthMethods(node.value.execution))) {
      methods.add(method);
    }

    for (const envName of listExecutionModelSecretNames(node.value.execution)) {
      requiredEnvNames.add(envName);
      optionalEnvNames.delete(envName);
    }

    for (const envName of listAgentSurfaceSecretNames(node.value.surfaces)) {
      requiredEnvNames.add(envName);
      optionalEnvNames.delete(envName);
    }
  }

  return { methods, optionalEnvNames, requiredEnvNames };
};

const readEnvFile = async (envFilePath?: string): Promise<Record<string, string>> =>
  envFilePath ? parseEnvFile(await readUtf8File(envFilePath)) : {};

const resolveEnvValue = (
  envName: string,
  fileEnv: Record<string, string>
): string | null => {
  const processValue = process.env[envName];
  if (typeof processValue === "string" && processValue.length > 0) {
    return processValue;
  }

  const fileValue = fileEnv[envName];
  if (typeof fileValue === "string" && fileValue.length > 0) {
    return fileValue;
  }

  return null;
};

const resolveRequiredEnv = async (
  requiredEnvNames: Set<string>,
  optionalEnvNames: Set<string>,
  envFilePath?: string
): Promise<Record<string, string>> => {
  if (requiredEnvNames.size === 0 && optionalEnvNames.size === 0) {
    return {};
  }

  const fileEnv = await readEnvFile(envFilePath);
  const resolvedEnv: Record<string, string> = {};
  const missingEnv: string[] = [];

  for (const envName of [...requiredEnvNames].sort()) {
    const value = resolveEnvValue(envName, fileEnv);
    if (value !== null) {
      resolvedEnv[envName] = value;
      continue;
    }

    missingEnv.push(envName);
  }

  if (missingEnv.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Missing required auth env: ${missingEnv.join(", ")}`
    );
  }

  for (const envName of [...optionalEnvNames].sort()) {
    if (requiredEnvNames.has(envName)) {
      continue;
    }

    const value = resolveEnvValue(envName, fileEnv);
    if (value !== null) {
      resolvedEnv[envName] = value;
    }
  }

  return resolvedEnv;
};

export const syncProjectAuth = async (
  inputPath: string,
  options: SyncProjectAuthOptions
) => {
  const { methods, optionalEnvNames, requiredEnvNames } = await resolveAuthRequirements(inputPath);

  await ensureAuthProfile(options.profileName);

  if (methods.has("codex")) {
    await importCodexAuth(options.profileName, options.codexDirectory);
  }

  if (methods.has("claude-code")) {
    await importClaudeCodeAuth(options.profileName, options.claudeCodeDirectory);
  }

  if (requiredEnvNames.size > 0 || optionalEnvNames.size > 0) {
    await setAuthProfileEnv(
      options.profileName,
      await resolveRequiredEnv(requiredEnvNames, optionalEnvNames, options.envFilePath)
    );
  }

  return requireAuthProfile(options.profileName);
};
