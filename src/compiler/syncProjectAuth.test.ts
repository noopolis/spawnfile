import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";

import { syncProjectAuth } from "./syncProjectAuth.js";

const fixturesRoot = path.resolve(process.cwd(), "fixtures");
const temporaryDirectories: string[] = [];
const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const previousOpenAiKey = process.env.OPENAI_API_KEY;

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const createAgentProject = async (manifestLines: string[]): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-auth-sync-project-");
  await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
  await writeUtf8File(path.join(directory, "Spawnfile"), `${manifestLines.join("\n")}\n`);
  return directory;
};

afterEach(async () => {
  if (previousSpawnfileHome === undefined) {
    delete process.env.SPAWNFILE_HOME;
  } else {
    process.env.SPAWNFILE_HOME = previousSpawnfileHome;
  }

  if (previousOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAiKey;
  }

  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("syncProjectAuth", () => {
  it("imports Codex and Claude Code auth from declared provider methods", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const codexHome = await createTempDirectory("spawnfile-codex-home-");
    const claudeHome = await createTempDirectory("spawnfile-claude-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    await writeUtf8File(path.join(codexHome, "auth.json"), "{\"token\":\"codex\"}\n");
    await writeUtf8File(
      path.join(claudeHome, ".credentials.json"),
      "{\"claudeAiOauth\":{\"accessToken\":\"claude\",\"expiresAt\":1800000000000}}\n"
    );

    const projectDirectory = await createAgentProject([
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: auth-sync",
      "",
      "runtime: openclaw",
      "",
      "execution:",
      "  model:",
      "    primary:",
      "      provider: openai",
      "      name: gpt-5",
      "    fallback:",
      "      - provider: anthropic",
      "        name: claude-sonnet-4-5",
      "    auth:",
      "      methods:",
      "        openai: codex",
      "        anthropic: claude-code",
      "",
      "docs:",
      "  system: AGENTS.md"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      claudeCodeDirectory: claudeHome,
      codexDirectory: codexHome,
      profileName: "dev"
    });

    expect(await readUtf8File(path.join(profile.imports.codex!.path, "auth.json"))).toContain(
      "\"codex\""
    );
    expect(
      await readUtf8File(path.join(profile.imports["claude-code"]!.path, ".credentials.json"))
    ).toContain("\"claude\"");
  });

  it("captures required API-key auth env from process env and env files", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    process.env.OPENAI_API_KEY = "process-openai";
    await writeUtf8File(path.join(envDirectory, ".env"), "ANTHROPIC_API_KEY=file-anthropic\n");

    const projectDirectory = await createAgentProject([
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: auth-sync",
      "",
      "runtime: openclaw",
      "",
      "execution:",
      "  model:",
      "    primary:",
      "      provider: openai",
      "      name: gpt-5",
      "    fallback:",
      "      - provider: anthropic",
      "        name: claude-sonnet-4-5",
      "    auth:",
      "      method: api_key",
      "",
      "docs:",
      "  system: AGENTS.md"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      ANTHROPIC_API_KEY: "file-anthropic",
      OPENAI_API_KEY: "process-openai"
    });
  });

  it("fails when required API-key auth env is missing", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    delete process.env.OPENAI_API_KEY;

    const projectDirectory = await createAgentProject([
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: auth-sync",
      "",
      "runtime: openclaw",
      "",
      "execution:",
      "  model:",
      "    primary:",
      "      provider: openai",
      "      name: gpt-5",
      "    auth:",
      "      method: api_key",
      "",
      "docs:",
      "  system: AGENTS.md"
    ]);

    await expect(
      syncProjectAuth(projectDirectory, {
        profileName: "dev"
      })
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "Missing required API-key auth env: OPENAI_API_KEY"
    });
  });

  it("syncs auth for team projects by collecting requirements from member agents", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const claudeHome = await createTempDirectory("spawnfile-claude-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    await writeUtf8File(
      path.join(claudeHome, ".credentials.json"),
      "{\"claudeAiOauth\":{\"accessToken\":\"claude\",\"expiresAt\":1800000000000}}\n"
    );
    await writeUtf8File(
      path.join(envDirectory, ".env"),
      "ANTHROPIC_API_KEY=file-anthropic\nOPENAI_API_KEY=file-openai\n"
    );

    const profile = await syncProjectAuth(path.join(fixturesRoot, "multi-runtime-team"), {
      claudeCodeDirectory: claudeHome,
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      ANTHROPIC_API_KEY: "file-anthropic",
      OPENAI_API_KEY: "file-openai"
    });
    expect(profile.imports["claude-code"]).toBeDefined();
    expect(profile.imports.codex).toBeUndefined();
  });
});
