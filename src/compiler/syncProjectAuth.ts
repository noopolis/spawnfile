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

import { buildCompilePlan } from "./buildCompilePlan.js";
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

const resolveModelAuthRequirements = async (
  inputPath: string
): Promise<{ methods: Set<"api_key" | "claude-code" | "codex">; envNames: Set<string> }> => {
  const plan = await buildCompilePlan(inputPath);
  const methods = new Set<"api_key" | "claude-code" | "codex">();
  const envNames = new Set<string>();

  for (const node of plan.nodes) {
    if (node.value.kind !== "agent") {
      continue;
    }

    for (const method of Object.values(resolveExecutionModelAuthMethods(node.value.execution))) {
      methods.add(method);
    }

    for (const envName of listExecutionModelSecretNames(node.value.execution)) {
      envNames.add(envName);
    }
  }

  return { envNames, methods };
};

const resolveApiKeyEnv = async (
  envNames: Set<string>,
  envFilePath?: string
): Promise<Record<string, string>> => {
  if (envNames.size === 0) {
    return {};
  }

  const fileEnv = envFilePath ? parseEnvFile(await readUtf8File(envFilePath)) : {};
  const resolvedEnv: Record<string, string> = {};
  const missingEnv: string[] = [];

  for (const envName of [...envNames].sort()) {
    const processValue = process.env[envName];
    if (typeof processValue === "string" && processValue.length > 0) {
      resolvedEnv[envName] = processValue;
      continue;
    }

    const fileValue = fileEnv[envName];
    if (typeof fileValue === "string" && fileValue.length > 0) {
      resolvedEnv[envName] = fileValue;
      continue;
    }

    missingEnv.push(envName);
  }

  if (missingEnv.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Missing required API-key auth env: ${missingEnv.join(", ")}`
    );
  }

  return resolvedEnv;
};

export const syncProjectAuth = async (
  inputPath: string,
  options: SyncProjectAuthOptions
) => {
  const { envNames, methods } = await resolveModelAuthRequirements(inputPath);

  await ensureAuthProfile(options.profileName);

  if (methods.has("codex")) {
    await importCodexAuth(options.profileName, options.codexDirectory);
  }

  if (methods.has("claude-code")) {
    await importClaudeCodeAuth(options.profileName, options.claudeCodeDirectory);
  }

  if (methods.has("api_key")) {
    await setAuthProfileEnv(
      options.profileName,
      await resolveApiKeyEnv(envNames, options.envFilePath)
    );
  }

  return requireAuthProfile(options.profileName);
};
