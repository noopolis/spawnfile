import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
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

export async function seedPiOpenAICodexAuthFromCodex(input: {
  codexAuthPath: string;
  piAuthPath: string;
}): Promise<void> {
  const raw = await import("node:fs/promises").then((fs) => fs.readFile(input.codexAuthPath, "utf8"));
  const codex = JSON.parse(raw) as CodexAuthFile;
  const access = codex.tokens?.access_token;
  const refresh = codex.tokens?.refresh_token;
  const accountId = codex.tokens?.account_id;

  if (!access || !refresh || !accountId) {
    throw new Error(`Codex auth file is missing access_token, refresh_token, or account_id: ${input.codexAuthPath}`);
  }

  await mkdir(path.dirname(input.piAuthPath), { recursive: true });
  const piAuth = {
    "openai-codex": {
      type: "oauth",
      access,
      refresh,
      expires: resolveExpires(access),
      accountId
    }
  };
  await writeFile(input.piAuthPath, `${JSON.stringify(piAuth, null, 2)}\n`, { mode: 0o600 });
}

