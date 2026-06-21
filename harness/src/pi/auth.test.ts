import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  seedPiAnthropicAuthFromClaudeCode,
  seedPiApiKeyAuth,
  seedPiOpenAICodexAuthFromCodex
} from "./auth.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-auth-"));
  tempRoots.push(directory);
  return directory;
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("seeds Codex OAuth credentials into Pi auth storage", async () => {
  const root = await tempDir();
  const codexAuthPath = path.join(root, "codex", "auth.json");
  const piAuthPath = path.join(root, "pi", "auth.json");
  await mkdir(path.dirname(codexAuthPath), { recursive: true });
  await writeFile(codexAuthPath, JSON.stringify({
    tokens: {
      access_token: "codex-access",
      account_id: "acct-123",
      refresh_token: "codex-refresh"
    }
  }));

  await seedPiOpenAICodexAuthFromCodex({ codexAuthPath, piAuthPath });

  const auth = await readJson(piAuthPath);
  const codex = auth["openai-codex"] as Record<string, unknown>;
  assert.equal(typeof codex.expires, "number");
  assert.deepEqual({ ...codex, expires: 0 }, {
    type: "oauth",
    access: "codex-access",
    refresh: "codex-refresh",
    expires: 0,
    accountId: "acct-123"
  });
});

test("throws when Codex credentials are incomplete", async () => {
  const root = await tempDir();
  const codexAuthPath = path.join(root, "codex", "auth.json");
  const piAuthPath = path.join(root, "pi", "auth.json");
  await mkdir(path.dirname(codexAuthPath), { recursive: true });
  await writeFile(codexAuthPath, JSON.stringify({
    "openai-codex": {
      type: "oauth"
    }
  }));

  await assert.rejects(
    seedPiOpenAICodexAuthFromCodex({ codexAuthPath, piAuthPath }),
    /missing access_token/
  );
});

test("seeds Claude Code credentials as Anthropic OAuth when refresh is available", async () => {
  const root = await tempDir();
  const claudeCredentialsPath = path.join(root, ".credentials.json");
  const piAuthPath = path.join(root, "pi", "auth.json");
  await writeFile(claudeCredentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: "claude-access",
      expiresAt: 1_800_000_000_000,
      refreshToken: "claude-refresh"
    }
  }));

  await seedPiAnthropicAuthFromClaudeCode({ claudeCredentialsPath, piAuthPath });

  assert.deepEqual(await readJson(piAuthPath), {
    anthropic: {
      type: "oauth",
      access: "claude-access",
      refresh: "claude-refresh",
      expires: 1_800_000_000_000
    }
  });
});

test("seeds Claude token credentials as Anthropic API-key storage", async () => {
  const root = await tempDir();
  const claudeCredentialsPath = path.join(root, ".credentials.json");
  const piAuthPath = path.join(root, "pi", "auth.json");
  await writeFile(claudeCredentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: "claude-access-token",
      expiresAt: 1_800_000_000_000
    }
  }));

  await seedPiAnthropicAuthFromClaudeCode({ claudeCredentialsPath, piAuthPath });

  assert.deepEqual(await readJson(piAuthPath), {
    anthropic: {
      type: "api_key",
      key: "claude-access-token"
    }
  });
});

test("merges API-key credentials without dropping existing providers", async () => {
  const root = await tempDir();
  const piAuthPath = path.join(root, "pi", "auth.json");
  await seedPiApiKeyAuth({ apiKey: "sk-openai", piAuthPath, provider: "openai" });
  await seedPiApiKeyAuth({
    apiKey: "$LOCAL_MODEL_KEY",
    env: { LOCAL_MODEL_KEY: "runtime-key" },
    piAuthPath,
    provider: "local-openai"
  });

  assert.deepEqual(await readJson(piAuthPath), {
    "local-openai": {
      type: "api_key",
      key: "$LOCAL_MODEL_KEY",
      env: { LOCAL_MODEL_KEY: "runtime-key" }
    },
    openai: {
      type: "api_key",
      key: "sk-openai"
    }
  });
});
