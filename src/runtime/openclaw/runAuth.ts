import path from "node:path";

import { loadImportedClaudeCodeCredential, loadImportedCodexCredential } from "../../auth/index.js";
import { ensureDirectory, writeUtf8File } from "../../filesystem/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

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

/**
 * Injects the consumer's imported OAuth credentials for an OpenClaw instance.
 * The OAuth-mode config is already baked into the image at compile time, so this
 * only materializes and mounts the credential tokens — no source rootfs needed,
 * which is what lets it run for both project deployments and sourceless images.
 */
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

  return {
    coveredModelSecrets,
    mountArgs
  };
};
