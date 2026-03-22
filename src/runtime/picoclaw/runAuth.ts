import path from "node:path";

import { loadImportedClaudeCodeCredential, loadImportedCodexCredential } from "../../auth/index.js";
import {
  copyDirectory,
  ensureDirectory,
  readUtf8File,
  writeUtf8File
} from "../../filesystem/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

const resolveRootfsSourcePath = (outputDirectory: string, containerPath: string): string =>
  path.join(
    outputDirectory,
    "container",
    "rootfs",
    ...path.posix.relative("/", containerPath).split("/")
  );

const createMountArgs = (hostPath: string, containerPath: string): string[] => [
  "-v",
  `${hostPath}:${containerPath}`
];

const createMountedHomeDirectory = async (
  input: RuntimeAuthPreparationInput,
  patchedConfig: Record<string, unknown>,
  authStore: Record<string, unknown> | null
): Promise<string> => {
  const sourceHomePath = resolveRootfsSourcePath(input.outputDirectory, input.instance.home_path!);
  const mountedHomePath = path.join("runtime-auth", "picoclaw", input.instance.id, "home");
  const hostHomePath = path.join(input.tempRoot, mountedHomePath);

  await ensureDirectory(path.dirname(hostHomePath));
  await copyDirectory(sourceHomePath, hostHomePath);

  const relativeConfigPath = path.posix.relative(input.instance.home_path!, input.instance.config_path);
  const hostConfigPath = path.join(hostHomePath, ...relativeConfigPath.split("/"));
  const hostAuthPath = path.join(hostHomePath, "auth.json");

  await ensureDirectory(path.dirname(hostConfigPath));
  await writeUtf8File(hostConfigPath, `${JSON.stringify(patchedConfig, null, 2)}\n`);
  if (authStore) {
    await writeUtf8File(hostAuthPath, `${JSON.stringify(authStore, null, 2)}\n`);
  }

  return hostHomePath;
};

const createPicoClawCredential = (
  provider: "anthropic" | "openai",
  credential: NonNullable<
    Awaited<ReturnType<typeof loadImportedClaudeCodeCredential>> | Awaited<ReturnType<typeof loadImportedCodexCredential>>
  >
): Record<string, unknown> => ({
  access_token: credential.access,
  ...("type" in credential && credential.type === "oauth" && credential.refresh
    ? { refresh_token: credential.refresh }
    : !("type" in credential)
      ? { refresh_token: credential.refresh }
      : {}),
  ...("accountId" in credential && credential.accountId ? { account_id: credential.accountId } : {}),
  auth_method: "oauth",
  expires_at: new Date(credential.expires).toISOString(),
  provider
});

const normalizeClaudeCliModelName = (modelName: string): string =>
  modelName.replaceAll(".", "-");

const patchPicoClawConfig = (
  config: Record<string, unknown>,
  options: { useClaudeCode: boolean; useCodex: boolean }
): Record<string, unknown> => {
  const agents = (config.agents as Record<string, unknown> | undefined) ?? {};
  const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {};
  const providers = ((config.providers as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const modelList = Array.isArray(config.model_list) ? config.model_list : [];

  const nextProviders: Record<string, Record<string, unknown>> = { ...providers };
  const nextModelList = modelList.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }

    const record = { ...(entry as Record<string, unknown>) };
    const model = record.model;
    const modelName = typeof record.model_name === "string" ? record.model_name : null;

    if (options.useClaudeCode && typeof model === "string" && model.startsWith("anthropic/")) {
      delete record.api_key;
      delete record.auth_method;
      if (modelName) {
        record.model = `claude-cli/${normalizeClaudeCliModelName(modelName)}`;
      }
    }

    if (options.useCodex && typeof model === "string" && model.startsWith("openai/")) {
      delete record.api_key;
      record.auth_method = "oauth";
    }

    return record;
  });

  if (options.useClaudeCode) {
    delete nextProviders.anthropic;
  }

  if (options.useCodex) {
    nextProviders.openai = {
      ...(nextProviders.openai ?? {}),
      auth_method: "oauth"
    };
  }

  return {
    ...config,
    agents: {
      ...agents,
      defaults
    },
    model_list: nextModelList,
    providers: nextProviders
  };
};

export const preparePicoClawRuntimeAuth = async (
  input: RuntimeAuthPreparationInput
): Promise<RuntimeAuthPreparationResult> => {
  if (!input.instance.home_path) {
    return { coveredModelSecrets: [], mountArgs: [] };
  }

  const claudeCode = input.authProfile.imports["claude-code"]
    ? await loadImportedClaudeCodeCredential(input.authProfile.imports["claude-code"].path)
    : null;
  const codex = input.authProfile.imports.codex
    ? await loadImportedCodexCredential(input.authProfile.imports.codex.path)
    : null;

  const useClaudeCode =
    input.instance.model_auth_methods.anthropic === "claude-code" && claudeCode;
  const useCodex =
    input.instance.model_auth_methods.openai === "codex" && codex;

  if (!useClaudeCode && !useCodex) {
    return { coveredModelSecrets: [], mountArgs: [] };
  }

  const credentials: Record<string, unknown> = {};
  const coveredModelSecrets: string[] = [];

  if (useCodex) {
    credentials.openai = createPicoClawCredential("openai", codex);
    coveredModelSecrets.push("OPENAI_API_KEY");
  }

  if (useClaudeCode) {
    coveredModelSecrets.push("ANTHROPIC_API_KEY");
  }

  const sourceConfig = JSON.parse(
    await readUtf8File(resolveRootfsSourcePath(input.outputDirectory, input.instance.config_path))
  ) as Record<string, unknown>;
  const patchedConfig = patchPicoClawConfig(sourceConfig, {
    useClaudeCode: Boolean(useClaudeCode),
    useCodex: Boolean(useCodex)
  });
  const mountedHomePath = await createMountedHomeDirectory(
    input,
    patchedConfig,
    Object.keys(credentials).length > 0 ? { credentials } : null
  );

  return {
    coveredModelSecrets,
    mountArgs: createMountArgs(mountedHomePath, input.instance.home_path)
  };
};
