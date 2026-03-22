import path from "node:path";
import { stat } from "node:fs/promises";

import { fileExists, readUtf8File } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

export interface ClaudeCodeImportedCredential {
  access: string;
  expires: number;
  refresh?: string;
  type: "oauth" | "token";
}

export interface CodexImportedCredential {
  access: string;
  accountId?: string;
  expires: number;
  refresh: string;
}

const parseJson = (filePath: string, content: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("top-level JSON value must be an object");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new SpawnfileError(
      "validation_error",
      `Invalid imported auth file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const loadImportedClaudeCodeCredential = async (
  sourceDirectory: string
): Promise<ClaudeCodeImportedCredential | null> => {
  const credentialsPath = path.join(sourceDirectory, ".credentials.json");
  if (!(await fileExists(credentialsPath))) {
    return null;
  }

  const parsed = parseJson(credentialsPath, await readUtf8File(credentialsPath));
  const oauth = parsed.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    return null;
  }

  const access = (oauth as Record<string, unknown>).accessToken;
  const refresh = (oauth as Record<string, unknown>).refreshToken;
  const expires = (oauth as Record<string, unknown>).expiresAt;

  if (typeof access !== "string" || access.length === 0) {
    return null;
  }

  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) {
    return null;
  }

  if (typeof refresh === "string" && refresh.length > 0) {
    return {
      access,
      expires,
      refresh,
      type: "oauth"
    };
  }

  return {
    access,
    expires,
    type: "token"
  };
};

export const loadImportedCodexCredential = async (
  sourceDirectory: string
): Promise<CodexImportedCredential | null> => {
  const authPath = path.join(sourceDirectory, "auth.json");
  if (!(await fileExists(authPath))) {
    return null;
  }

  const parsed = parseJson(authPath, await readUtf8File(authPath));
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }

  const access = (tokens as Record<string, unknown>).access_token;
  const refresh = (tokens as Record<string, unknown>).refresh_token;
  const accountId = (tokens as Record<string, unknown>).account_id;

  if (
    typeof access !== "string" ||
    access.length === 0 ||
    typeof refresh !== "string" ||
    refresh.length === 0
  ) {
    return null;
  }

  const fileStats = await stat(authPath);

  return {
    access,
    ...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
    expires: fileStats.mtimeMs + 60 * 60 * 1000,
    refresh
  };
};
