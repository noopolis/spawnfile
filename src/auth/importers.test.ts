import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";

import {
  importClaudeCodeAuth,
  importCodexAuth,
  importEnvFile,
  parseEnvFile
} from "./importers.js";
import { requireAuthProfile } from "./profileStore.js";

const temporaryDirectories: string[] = [];
const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const previousCodexHome = process.env.CODEX_HOME;

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  if (previousSpawnfileHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousSpawnfileHome;
  }
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("auth importers", () => {
  it("parses env files with comments and quoted values", () => {
    expect(
      parseEnvFile([
        "# Comment",
        "ANTHROPIC_API_KEY=ant-key",
        "OPENAI_API_KEY=\"openai-key\"",
        "MODEL_NAME='gpt-5.4'"
      ].join("\n"))
    ).toEqual({
      ANTHROPIC_API_KEY: "ant-key",
      MODEL_NAME: "gpt-5.4",
      OPENAI_API_KEY: "openai-key"
    });
  });

  it("rejects invalid env lines", () => {
    expect(() => parseEnvFile("NOT VALID")).toThrow(/Invalid env line: NOT VALID/);
  });

  it("imports env files into a profile", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    const envFilePath = path.join(await createTempDirectory("spawnfile-env-file-"), ".env");
    await writeUtf8File(envFilePath, "ANTHROPIC_API_KEY=ant-key\nOPENAI_API_KEY=openai-key\n");

    const profile = await importEnvFile("dev", envFilePath);

    expect(profile.env).toEqual({
      ANTHROPIC_API_KEY: "ant-key",
      OPENAI_API_KEY: "openai-key"
    });
  });

  it("imports codex auth from CODEX_HOME", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    const codexHome = await createTempDirectory("spawnfile-codex-home-");
    process.env.CODEX_HOME = codexHome;
    await writeUtf8File(path.join(codexHome, "auth.json"), "{\"token\":\"codex\"}\n");

    const profile = await importCodexAuth("dev");

    expect(await readUtf8File(path.join(profile.imports.codex!.path, "auth.json"))).toContain(
      "\"codex\""
    );
  });

  it("merges env imports and Codex imports into the same profile", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    const envFilePath = path.join(await createTempDirectory("spawnfile-env-file-"), ".env");
    const codexHome = await createTempDirectory("spawnfile-codex-home-");
    process.env.CODEX_HOME = codexHome;
    await writeUtf8File(envFilePath, "SEARCH_API_KEY=search-key\n");
    await writeUtf8File(path.join(codexHome, "auth.json"), "{\"token\":\"codex\"}\n");

    await importEnvFile("dev", envFilePath);
    const profile = await importCodexAuth("dev");

    expect(profile.env).toEqual({
      SEARCH_API_KEY: "search-key"
    });
    expect(profile.imports.codex).toBeDefined();
  });

  it("fails when env or imported auth sources do not exist", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    await expect(importEnvFile("dev", "/tmp/missing.env")).rejects.toMatchObject({
      code: "validation_error"
    });
    await expect(importCodexAuth("dev", "/tmp/missing-codex")).rejects.toMatchObject({
      code: "validation_error"
    });
    await expect(importClaudeCodeAuth("dev", "/tmp/missing-claude")).rejects.toMatchObject({
      code: "validation_error"
    });
  });

  it("imports claude code credentials from a source directory", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    const claudeHome = await createTempDirectory("spawnfile-claude-home-");
    await ensureDirectory(claudeHome);
    await writeUtf8File(path.join(claudeHome, ".credentials.json"), "{\"token\":\"claude\"}\n");

    await importClaudeCodeAuth("dev", claudeHome);
    const profile = await requireAuthProfile("dev");

    expect(
      await readUtf8File(path.join(profile.imports["claude-code"]!.path, ".credentials.json"))
    ).toContain("\"claude\"");
  });

  it("imports claude code credentials from macOS keychain fallback", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    await importClaudeCodeAuth("dev", undefined, {
      readKeychainCredentials: async () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-access",
            expiresAt: 1_800_000_000_000,
            refreshToken: "claude-refresh"
          }
        })
    });
    const profile = await requireAuthProfile("dev");

    expect(
      await readUtf8File(path.join(profile.imports["claude-code"]!.path, ".credentials.json"))
    ).toContain("\"claude-access\"");
  });
});
