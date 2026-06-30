import path from "node:path";
import os from "node:os";
import { chmod, cp, lstat, readdir } from "node:fs/promises";

import {
  loadImportedClaudeCodeCredential,
  loadImportedCodexCredential
} from "../../auth/index.js";
import { ensureDirectory, fileExists, writeUtf8File } from "../../filesystem/index.js";
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

const copyIfExists = async (
  sourcePath: string,
  targetPath: string
): Promise<void> => {
  if (!await fileExists(sourcePath)) {
    return;
  }
  await ensureDirectory(path.dirname(targetPath));
  await cp(sourcePath, targetPath, {
    dereference: true,
    force: true,
    recursive: true
  });
};

const makeReadable = async (targetPath: string): Promise<void> => {
  const stats = await lstat(targetPath);
  if (!stats.isDirectory()) {
    await chmod(targetPath, 0o644);
    return;
  }

  await chmod(targetPath, 0o755);
  for (const entry of await readdir(targetPath)) {
    await makeReadable(path.join(targetPath, entry));
  }
};

const stageCliHome = async (
  sourcePath: string,
  tempRoot: string,
  relativeTarget: string,
  entries: string[]
): Promise<string> => {
  const targetPath = path.join(tempRoot, "runtime-auth", "pi", relativeTarget);
  await ensureDirectory(targetPath);
  for (const entry of entries) {
    await copyIfExists(path.join(sourcePath, entry), path.join(targetPath, entry));
  }
  await makeReadable(targetPath);
  return targetPath;
};

const stageGrokHome = async (
  sourcePath: string,
  tempRoot: string
): Promise<string> =>
  stageCliHome(sourcePath, tempRoot, "grok-home", [
    ".metadata_version",
    "auth.json",
    "config.toml",
    "mcp_credentials.json",
    "version.json",
    "worktrees.db"
  ]);

const stageAntigravityHome = async (
  sourcePath: string,
  tempRoot: string
): Promise<string> =>
  stageCliHome(sourcePath, tempRoot, "antigravity-home", [
    "Cookies",
    "Cookies-journal",
    "Local Storage",
    "Preferences",
    "Session Storage",
    "app_storage.json"
  ]);

const stageAntigravityCliHome = async (
  sourcePath: string,
  tempRoot: string
): Promise<string> =>
  stageCliHome(sourcePath, tempRoot, "antigravity-cli-home", [
    "antigravity-oauth-token",
    "cache/default_project_id.txt",
    "cache/onboarding.json",
    "config/.migrated",
    "config/mcp_config.json"
  ]);

const firstExistingDirectory = async (paths: string[]): Promise<string | null> => {
  for (const candidate of paths) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
};

const collectOptionalCliHomeMounts = async (
  containerHomePath: string,
  tempRoot: string
): Promise<string[]> => {
  const home = os.homedir();
  const mounts: string[] = [];
  const grokCandidates = process.env.GROK_HOME
    ? [process.env.GROK_HOME]
    : [path.join(home, ".grok")];
  const grokHome = await firstExistingDirectory(grokCandidates);
  if (grokHome) {
    mounts.push(...createMountArgs(
      await stageGrokHome(grokHome, tempRoot),
      path.posix.join(containerHomePath, ".grok")
    ));
  }

  const antigravityCandidates = process.env.ANTIGRAVITY_HOME
    ? [process.env.ANTIGRAVITY_HOME]
    : process.env.AGY_HOME
      ? [process.env.AGY_HOME]
      : [
          path.join(home, "Library", "Application Support", "Antigravity"),
          path.join(home, ".config", "Antigravity"),
          path.join(home, ".antigravity")
        ];
  const antigravityHome = await firstExistingDirectory(antigravityCandidates);
  if (antigravityHome) {
    mounts.push(...createMountArgs(
      await stageAntigravityHome(antigravityHome, tempRoot),
      path.posix.join(containerHomePath, ".config", "Antigravity")
    ));
  }

  const antigravityCliCandidates = process.env.ANTIGRAVITY_CLI_HOME
    ? [process.env.ANTIGRAVITY_CLI_HOME]
    : [path.join(home, ".gemini", "antigravity-cli")];
  const antigravityCliHome = await firstExistingDirectory(antigravityCliCandidates);
  if (antigravityCliHome) {
    mounts.push(...createMountArgs(
      await stageAntigravityCliHome(antigravityCliHome, tempRoot),
      path.posix.join(containerHomePath, ".gemini", "antigravity-cli")
    ));
  }

  return mounts;
};

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
  const mountArgs = await collectOptionalCliHomeMounts(
    input.instance.home_path,
    input.tempRoot
  );

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

  if (useCodex || useClaudeCode) {
    const authPath = await writeJsonFile(
      input.tempRoot,
      path.join("runtime-auth", "pi", input.instance.id, "auth.json"),
      authProfiles
    );
    mountArgs.push(...createMountArgs(
      authPath,
      path.posix.join(input.instance.home_path, ".pi", "agent", "auth.json")
    ));
  }

  return {
    coveredModelSecrets: [
      ...collectCoveredSecrets(input.instance.model_secrets_required, Boolean(useCodex), "OPENAI_API_KEY"),
      ...collectCoveredSecrets(input.instance.model_secrets_required, Boolean(useClaudeCode), "ANTHROPIC_API_KEY")
    ],
    mountArgs
  };
};
