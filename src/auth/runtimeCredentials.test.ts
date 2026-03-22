import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";

import {
  loadImportedClaudeCodeCredential,
  loadImportedCodexCredential
} from "./runtimeCredentials.js";

const temporaryDirectories: string[] = [];

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("runtimeCredentials", () => {
  it("loads Claude Code oauth credentials", async () => {
    const claudeHome = await createTempDirectory("spawnfile-claude-creds-");
    await writeUtf8File(
      path.join(claudeHome, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access",
          expiresAt: 1_800_000_000_000,
          refreshToken: "claude-refresh"
        }
      })
    );

    await expect(loadImportedClaudeCodeCredential(claudeHome)).resolves.toEqual({
      access: "claude-access",
      expires: 1_800_000_000_000,
      refresh: "claude-refresh",
      type: "oauth"
    });
  });

  it("loads Claude Code token credentials when no refresh token is present", async () => {
    const claudeHome = await createTempDirectory("spawnfile-claude-creds-");
    await writeUtf8File(
      path.join(claudeHome, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "claude-access",
          expiresAt: 1_800_000_000_000
        }
      })
    );

    await expect(loadImportedClaudeCodeCredential(claudeHome)).resolves.toEqual({
      access: "claude-access",
      expires: 1_800_000_000_000,
      type: "token"
    });
  });

  it("loads Codex credentials and derives expiry from file metadata", async () => {
    const codexHome = await createTempDirectory("spawnfile-codex-creds-");
    await writeUtf8File(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "codex-access",
          account_id: "acct-123",
          refresh_token: "codex-refresh"
        }
      })
    );

    const credential = await loadImportedCodexCredential(codexHome);

    expect(credential).toMatchObject({
      access: "codex-access",
      accountId: "acct-123",
      refresh: "codex-refresh"
    });
    expect(credential?.expires).toBeGreaterThan(Date.now());
  });

  it("rejects invalid imported auth JSON", async () => {
    const claudeHome = await createTempDirectory("spawnfile-claude-creds-");
    await writeUtf8File(path.join(claudeHome, ".credentials.json"), "{not-json}\n");

    await expect(loadImportedClaudeCodeCredential(claudeHome)).rejects.toMatchObject({
      code: "validation_error"
    });
  });

  it("returns null when imported auth files are missing or incomplete", async () => {
    const missingHome = await createTempDirectory("spawnfile-missing-creds-");
    const incompleteClaudeHome = await createTempDirectory("spawnfile-claude-creds-");
    const incompleteCodexHome = await createTempDirectory("spawnfile-codex-creds-");
    await writeUtf8File(
      path.join(incompleteClaudeHome, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: 0 } })
    );
    await writeUtf8File(
      path.join(incompleteCodexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "only-access" } })
    );

    await expect(loadImportedClaudeCodeCredential(missingHome)).resolves.toBeNull();
    await expect(loadImportedClaudeCodeCredential(incompleteClaudeHome)).resolves.toBeNull();
    await expect(loadImportedCodexCredential(missingHome)).resolves.toBeNull();
    await expect(loadImportedCodexCredential(incompleteCodexHome)).resolves.toBeNull();
  });
});
