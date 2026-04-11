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

const writeRuntimeAuthFile = async (
  input: RuntimeAuthPreparationInput,
  relativePath: string,
  content: string
): Promise<string> => {
  const hostPath = path.join(
    input.tempRoot,
    "runtime-auth",
    "tinyclaw",
    input.instance.id,
    ...relativePath.split("/")
  );
  await ensureDirectory(path.dirname(hostPath));
  await writeUtf8File(hostPath, content);
  return hostPath;
};

const writePatchedSettings = async (
  input: RuntimeAuthPreparationInput,
  config: Record<string, unknown>
): Promise<string> => {
  return writeRuntimeAuthFile(input, "settings.json", `${JSON.stringify(config, null, 2)}\n`);
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
  const mountArgs = createMountArgs(patchedConfigPath, input.instance.config_path);

  if (input.instance.home_path && input.instance.model_auth_methods.anthropic === "claude-code" && claudeCode) {
    const mountedClaudePath = await writeRuntimeAuthFile(
      input,
      ".claude/.credentials.json",
      await readUtf8File(path.join(input.authProfile.imports["claude-code"]!.path, ".credentials.json"))
    );
    mountArgs.push(
      ...createMountArgs(
        mountedClaudePath,
        path.posix.join(input.instance.home_path, ".claude", ".credentials.json")
      )
    );
  }

  if (input.instance.home_path && input.instance.model_auth_methods.openai === "codex" && codex) {
    const mountedAuthPath = await writeRuntimeAuthFile(
      input,
      ".codex/auth.json",
      await readUtf8File(path.join(input.authProfile.imports.codex!.path, "auth.json"))
    );
    mountArgs.push(
      ...createMountArgs(
        mountedAuthPath,
        path.posix.join(input.instance.home_path, ".codex", "auth.json")
      )
    );
  }

  return {
    coveredModelSecrets,
    mountArgs
  };
};
