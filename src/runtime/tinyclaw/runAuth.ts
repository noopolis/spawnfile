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

const createMountArgs = (hostPath: string, containerPath: string): string[] => [
  "-v",
  `${hostPath}:${containerPath}`
];

const writePatchedSettings = async (
  input: RuntimeAuthPreparationInput,
  config: Record<string, unknown>
): Promise<string> => {
  const hostPath = path.join(
    input.tempRoot,
    "runtime-auth",
    "tinyclaw",
    input.instance.id,
    "settings.json"
  );
  await ensureDirectory(path.dirname(hostPath));
  await writeUtf8File(hostPath, `${JSON.stringify(config, null, 2)}\n`);
  return hostPath;
};

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

  const sourceConfig = JSON.parse(
    await readUtf8File(resolveRootfsSourcePath(input.outputDirectory, input.instance.config_path))
  ) as Record<string, unknown>;
  const patchedConfigPath = await writePatchedSettings(input, sourceConfig);

  return {
    coveredModelSecrets,
    mountArgs: createMountArgs(patchedConfigPath, input.instance.config_path)
  };
};
