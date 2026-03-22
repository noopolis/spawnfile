import path from "node:path";

import { loadImportedClaudeCodeCredential, loadImportedCodexCredential } from "../../auth/index.js";
import { ensureDirectory, readUtf8File, writeUtf8File } from "../../filesystem/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

const resolveRootfsSourcePath = (outputDirectory: string, containerPath: string): string =>
  path.join(
    outputDirectory,
    "container",
    "rootfs",
    ...path.posix.relative("/", containerPath).split("/")
  );

const writeJsonFile = async (
  tempRoot: string,
  relativePath: string,
  value: Record<string, unknown>
): Promise<string> => {
  const hostPath = path.join(tempRoot, relativePath);
  await ensureDirectory(path.dirname(hostPath));
  await writeUtf8File(hostPath, `${JSON.stringify(value, null, 2)}\n`);
  return hostPath;
};

const createMountArgs = (hostPath: string, containerPath: string): string[] => [
  "-v",
  `${hostPath}:${containerPath}`
];

const createOpenClawCredential = (
  provider: "anthropic" | "openai-codex",
  credential: Awaited<ReturnType<typeof loadImportedClaudeCodeCredential>> | Awaited<ReturnType<typeof loadImportedCodexCredential>>
): Record<string, unknown> =>
  credential && "type" in credential
    ? credential.type === "oauth"
      ? {
          access: credential.access,
          expires: credential.expires,
          provider,
          refresh: credential.refresh,
          type: "oauth"
        }
      : {
          expires: credential.expires,
          provider,
          token: credential.access,
          type: "token"
        }
    : {
        access: credential!.access,
        ...("accountId" in credential! && credential!.accountId ? { accountId: credential!.accountId } : {}),
        expires: credential!.expires,
        provider,
        refresh: credential!.refresh,
        type: "oauth"
      };

const normalizeOpenClawCodexModel = (model: string): string => {
  const modelName = model.slice("openai/".length);
  return modelName === "gpt-5" ? "gpt-5.4" : modelName;
};

const patchOpenClawConfig = (
  config: Record<string, unknown>,
  options: { useClaudeCode: boolean; useCodex: boolean }
): Record<string, unknown> => {
  const agents = (config.agents as Record<string, unknown> | undefined) ?? {};
  const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {};
  const model = defaults.model;
  const auth = (config.auth as Record<string, unknown> | undefined) ?? {};
  const profiles = (auth.profiles as Record<string, unknown> | undefined) ?? {};
  const order = (auth.order as Record<string, unknown> | undefined) ?? {};

  if (options.useCodex && typeof model === "string" && model.startsWith("openai/")) {
    defaults.model = `openai-codex/${normalizeOpenClawCodexModel(model)}`;
  }

  if (options.useClaudeCode) {
    profiles["anthropic:default"] = {
      mode: "oauth",
      provider: "anthropic"
    };
    order.anthropic = ["anthropic:default"];
  }

  if (options.useCodex) {
    profiles["openai-codex:default"] = {
      mode: "oauth",
      provider: "openai-codex"
    };
    order["openai-codex"] = ["openai-codex:default"];
  }

  return {
    ...config,
    agents: {
      ...agents,
      defaults
    },
    auth: {
      ...auth,
      order,
      profiles
    }
  };
};

export const prepareOpenClawRuntimeAuth = async (
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

  const coveredModelSecrets: string[] = [];
  const authProfiles: Record<string, unknown> = {};
  let patchedConfig: Record<string, unknown> | null = null;
  const useClaudeCode = input.instance.model_auth_methods.anthropic === "claude-code" && claudeCode;
  const useCodex = input.instance.model_auth_methods.openai === "codex" && codex;

  if (useClaudeCode) {
    authProfiles["anthropic:default"] = createOpenClawCredential("anthropic", claudeCode);
    coveredModelSecrets.push("ANTHROPIC_API_KEY");
  }

  if (useCodex) {
    authProfiles["openai-codex:default"] = createOpenClawCredential("openai-codex", codex);
    coveredModelSecrets.push("OPENAI_API_KEY");
  }

  if (useClaudeCode || useCodex) {
    const sourceConfig = JSON.parse(
      await readUtf8File(resolveRootfsSourcePath(input.outputDirectory, input.instance.config_path))
    ) as Record<string, unknown>;
    patchedConfig = patchOpenClawConfig(sourceConfig, {
      useClaudeCode: Boolean(useClaudeCode),
      useCodex: Boolean(useCodex)
    });
  }

  const mountArgs: string[] = [];

  if (Object.keys(authProfiles).length > 0) {
    const authStorePath = await writeJsonFile(
      input.tempRoot,
      path.join("runtime-auth", "openclaw", input.instance.id, "auth-profiles.json"),
      {
        profiles: authProfiles,
        version: 1
      }
    );
    mountArgs.push(
      ...createMountArgs(
        authStorePath,
        path.posix.join(
          input.instance.home_path,
          ".openclaw",
          "agents",
          "main",
          "agent",
          "auth-profiles.json"
        )
      )
    );
  }

  if (patchedConfig) {
    const patchedConfigPath = await writeJsonFile(
      input.tempRoot,
      path.join("runtime-auth", "openclaw", input.instance.id, "openclaw.json"),
      patchedConfig
    );
    mountArgs.push(...createMountArgs(patchedConfigPath, input.instance.config_path));
  }

  return {
    coveredModelSecrets,
    mountArgs
  };
};
