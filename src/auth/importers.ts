import path from "node:path";
import os from "node:os";

import {
  ensureDirectory,
  fileExists,
  readUtf8File,
  writeUtf8File
} from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

import { registerImportedAuth, setAuthProfileEnv } from "./profileStore.js";

const ENV_LINE_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;
const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

interface ClaudeCodeImportOptions {
  readKeychainCredentials?: () => Promise<string | null>;
}

const stripWrappedQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

export const parseEnvFile = (content: string): Record<string, string> => {
  const entries: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const match = rawLine.match(ENV_LINE_PATTERN);
    if (!match) {
      throw new SpawnfileError("validation_error", `Invalid env line: ${rawLine}`);
    }

    entries[match[1]] = stripWrappedQuotes(match[2] ?? "");
  }

  return entries;
};

export const importEnvFile = async (
  profileName: string,
  envFilePath: string
) => {
  if (!(await fileExists(envFilePath))) {
    throw new SpawnfileError("validation_error", `Env file does not exist: ${envFilePath}`);
  }

  return setAuthProfileEnv(profileName, parseEnvFile(await readUtf8File(envFilePath)));
};

const resolveHomeRelativePath = (defaultRelativePath: string, inputPath?: string): string => {
  if (inputPath) {
    return path.resolve(inputPath);
  }

  return path.join(os.homedir(), defaultRelativePath);
};

const resolveCodexSourceDirectory = (sourceDirectory?: string): string =>
  path.resolve(sourceDirectory ?? process.env.CODEX_HOME ?? resolveHomeRelativePath(".codex"));

const resolveClaudeSourceDirectory = (sourceDirectory?: string): string =>
  resolveHomeRelativePath(".claude", sourceDirectory);

const readClaudeCodeKeychainCredentials = async (): Promise<string | null> => {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      CLAUDE_CODE_KEYCHAIN_SERVICE,
      "-w"
    ]);
    const content = stdout.trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
};

export const importCodexAuth = async (
  profileName: string,
  sourceDirectory?: string
) => {
  const resolvedSource = resolveCodexSourceDirectory(sourceDirectory);
  const authFilePath = path.join(resolvedSource, "auth.json");

  if (!(await fileExists(authFilePath))) {
    throw new SpawnfileError(
      "validation_error",
      `Codex auth file does not exist: ${authFilePath}`
    );
  }

  const { directory, profile } = await registerImportedAuth(profileName, "codex");
  await writeUtf8File(path.join(directory, "auth.json"), await readUtf8File(authFilePath));
  return profile;
};

export const importClaudeCodeAuth = async (
  profileName: string,
  sourceDirectory?: string,
  options: ClaudeCodeImportOptions = {}
) => {
  const resolvedSource = resolveClaudeSourceDirectory(sourceDirectory);
  const credentialsPath = path.join(resolvedSource, ".credentials.json");
  let credentialsContent: string | null = null;

  if (await fileExists(credentialsPath)) {
    credentialsContent = await readUtf8File(credentialsPath);
  }

  if (!credentialsContent && !sourceDirectory) {
    const keychainCredentials = await (
      options.readKeychainCredentials ?? readClaudeCodeKeychainCredentials
    )();
    if (keychainCredentials) {
      credentialsContent = keychainCredentials;
    }
  }

  if (!credentialsContent) {
    throw new SpawnfileError(
      "validation_error",
      `Claude Code credentials file does not exist: ${credentialsPath} and macOS Keychain service ${CLAUDE_CODE_KEYCHAIN_SERVICE} was unavailable`
    );
  }

  const { directory, profile } = await registerImportedAuth(profileName, "claude-code");
  await ensureDirectory(directory);
  await writeUtf8File(path.join(directory, ".credentials.json"), credentialsContent);
  return profile;
};
