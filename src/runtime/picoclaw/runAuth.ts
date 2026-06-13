import { loadImportedClaudeCodeCredential } from "../../auth/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

/**
 * PicoClaw claude-cli (Claude Code) auth: the claude-cli model config is baked
 * into the image at compile time and the credential import (~/.claude) is
 * mounted into the runtime home by the caller, so this only reports that the
 * model secret is covered. No source rootfs is read, which is what lets it run
 * for both project deployments and sourceless images.
 */
export const preparePicoClawRuntimeAuth = async (
  input: RuntimeAuthPreparationInput
): Promise<RuntimeAuthPreparationResult> => {
  if (!input.instance.home_path) {
    return { coveredModelSecrets: [], mountArgs: [] };
  }

  const claudeCode = input.authProfile.imports["claude-code"]
    ? await loadImportedClaudeCodeCredential(input.authProfile.imports["claude-code"].path)
    : null;

  const useClaudeCode =
    input.instance.model_auth_methods.anthropic === "claude-code" && claudeCode;

  if (!useClaudeCode) {
    return { coveredModelSecrets: [], mountArgs: [] };
  }

  return { coveredModelSecrets: ["ANTHROPIC_API_KEY"], mountArgs: [] };
};
