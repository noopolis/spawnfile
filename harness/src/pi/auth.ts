import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

interface ClaudeCodeAuthFile {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    refreshToken?: string;
  };
}

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const payload = token.split(".")[1];
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const resolveExpires = (accessToken: string): number => {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  return typeof exp === "number" ? exp * 1000 : Date.now() + 30 * 60 * 1000;
};

const readJsonFile = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await readFile(filePath, "utf8")) as T;

const readPiAuth = async (piAuthPath: string): Promise<Record<string, unknown>> => {
  try {
    return await readJsonFile<Record<string, unknown>>(piAuthPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writePiAuth = async (
  piAuthPath: string,
  next: Record<string, unknown>
): Promise<void> => {
  await mkdir(path.dirname(piAuthPath), { recursive: true });
  await writeFile(piAuthPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
};

export async function seedPiOpenAICodexAuthFromCodex(input: {
  codexAuthPath: string;
  piAuthPath: string;
}): Promise<void> {
  const codex = await readJsonFile<CodexAuthFile>(input.codexAuthPath);
  const access = codex.tokens?.access_token;
  const refresh = codex.tokens?.refresh_token;
  const accountId = codex.tokens?.account_id;

  if (!access || !refresh || !accountId) {
    throw new Error(`Codex auth file is missing access_token, refresh_token, or account_id: ${input.codexAuthPath}`);
  }

  const piAuth = await readPiAuth(input.piAuthPath);
  piAuth["openai-codex"] = {
    type: "oauth",
    access,
    refresh,
    expires: resolveExpires(access),
    accountId
  };
  await writePiAuth(input.piAuthPath, piAuth);
}

export async function seedPiAnthropicAuthFromClaudeCode(input: {
  claudeCredentialsPath: string;
  piAuthPath: string;
}): Promise<void> {
  const claude = await readJsonFile<ClaudeCodeAuthFile>(input.claudeCredentialsPath);
  const access = claude.claudeAiOauth?.accessToken;
  const refresh = claude.claudeAiOauth?.refreshToken;
  const expires = claude.claudeAiOauth?.expiresAt;

  if (!access || typeof expires !== "number") {
    throw new Error(`Claude Code credentials are missing accessToken or expiresAt: ${input.claudeCredentialsPath}`);
  }

  const piAuth = await readPiAuth(input.piAuthPath);
  piAuth.anthropic = refresh
    ? {
        type: "oauth",
        access,
        refresh,
        expires
      }
    : {
        type: "api_key",
        key: access
      };
  await writePiAuth(input.piAuthPath, piAuth);
}

export async function seedPiApiKeyAuth(input: {
  apiKey: string;
  env?: Record<string, string>;
  piAuthPath: string;
  provider: string;
}): Promise<void> {
  if (input.apiKey.length === 0) {
    throw new Error(`API key for ${input.provider} must not be empty`);
  }

  const piAuth = await readPiAuth(input.piAuthPath);
  piAuth[input.provider] = {
    type: "api_key",
    key: input.apiKey,
    ...(input.env ? { env: input.env } : {})
  };
  await writePiAuth(input.piAuthPath, piAuth);
}

export function createPiOpenAICodexAuthFromCodexToken(input: {
  access: string;
  accountId?: string;
  refresh: string;
}): Record<string, unknown> {
  return {
    "openai-codex": {
      type: "oauth",
      access: input.access,
      refresh: input.refresh,
      expires: resolveExpires(input.access),
      ...(input.accountId ? { accountId: input.accountId } : {})
    }
  };
}
