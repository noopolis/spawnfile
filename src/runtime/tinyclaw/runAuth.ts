import { loadImportedClaudeCodeCredential, loadImportedCodexCredential } from "../../auth/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

export const prepareTinyClawRuntimeAuth = async (
  input: RuntimeAuthPreparationInput
): Promise<RuntimeAuthPreparationResult> => {
  const coveredModelSecrets: string[] = [];

  const claudeCode = input.authProfile.imports["claude-code"]
    ? await loadImportedClaudeCodeCredential(input.authProfile.imports["claude-code"].path)
    : null;
  const codex = input.authProfile.imports.codex
    ? await loadImportedCodexCredential(input.authProfile.imports.codex.path)
    : null;

  if (
    input.instance.model_auth_methods.anthropic === "claude-code" &&
    claudeCode
  ) {
    coveredModelSecrets.push("ANTHROPIC_API_KEY");
  }

  if (
    input.instance.model_auth_methods.openai === "codex" &&
    codex
  ) {
    coveredModelSecrets.push("OPENAI_API_KEY");
  }

  return {
    coveredModelSecrets,
    mountArgs: []
  };
};
