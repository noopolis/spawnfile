import path from "node:path";
import { chmod } from "node:fs/promises";

import {
  loadImportedClaudeCodeCredential,
  loadImportedCodexCredential
} from "../../auth/index.js";
import { ensureDirectory, writeUtf8File } from "../../filesystem/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

const createMountArgs = (hostPath: string, containerPath: string): string[] => [
  "-v",
  `${hostPath}:${containerPath}`
];

const writeJsonFile = async (
  tempRoot: string,
  relativePath: string,
  value: Record<string, unknown>
): Promise<string> => {
  const hostPath = path.join(tempRoot, relativePath);
  const hostDirectory = path.dirname(hostPath);
  await ensureDirectory(hostDirectory);
  await writeUtf8File(hostPath, `${JSON.stringify(value, null, 2)}\n`);
  await chmod(hostDirectory, 0o700);
  // Docker bind mounts preserve host file mode; the generated image runs as
  // the non-root `spawnfile` user, so the mounted auth file must be readable
  // by a UID that usually differs from the host owner.
  await chmod(hostPath, 0o644);
  return hostPath;
};

const collectCoveredSecrets = (
  instanceSecrets: string[],
  enabled: boolean,
  secretName: string
): string[] => enabled && instanceSecrets.includes(secretName) ? [secretName] : [];

export const preparePiRuntimeAuth = async (
  input: RuntimeAuthPreparationInput
): Promise<RuntimeAuthPreparationResult> => {
  if (!input.instance.home_path) {
    return { coveredModelSecrets: [], mountArgs: [] };
  }

  const codex = input.authProfile.imports.codex
    ? await loadImportedCodexCredential(input.authProfile.imports.codex.path)
    : null;
  const claudeCode = input.authProfile.imports["claude-code"]
    ? await loadImportedClaudeCodeCredential(input.authProfile.imports["claude-code"].path)
    : null;

  const useCodex = input.instance.model_auth_methods.openai === "codex" && codex;
  const useClaudeCode =
    input.instance.model_auth_methods.anthropic === "claude-code" && claudeCode;
  if (!useCodex && !useClaudeCode) {
    return { coveredModelSecrets: [], mountArgs: [] };
  }

  const authProfiles: Record<string, unknown> = {};
  if (useCodex) {
    authProfiles["openai-codex"] = {
      access: codex.access,
      ...(codex.accountId ? { accountId: codex.accountId } : {}),
      expires: codex.expires,
      refresh: codex.refresh,
      type: "oauth"
    };
  }

  if (useClaudeCode) {
    authProfiles.anthropic = claudeCode.type === "oauth" && claudeCode.refresh
      ? {
          access: claudeCode.access,
          expires: claudeCode.expires,
          refresh: claudeCode.refresh,
          type: "oauth"
        }
      : {
          key: claudeCode.access,
          type: "api_key"
        };
  }

  const authPath = await writeJsonFile(
    input.tempRoot,
    path.join("runtime-auth", "pi", input.instance.id, "auth.json"),
    authProfiles
  );

  return {
    coveredModelSecrets: [
      ...collectCoveredSecrets(input.instance.model_secrets_required, Boolean(useCodex), "OPENAI_API_KEY"),
      ...collectCoveredSecrets(input.instance.model_secrets_required, Boolean(useClaudeCode), "ANTHROPIC_API_KEY")
    ],
    mountArgs: createMountArgs(
      authPath,
      path.posix.join(input.instance.home_path, ".pi", "agent", "auth.json")
    )
  };
};
