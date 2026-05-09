import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDirectory,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";

import { syncProjectAuth } from "./syncProjectAuth.js";

const temporaryDirectories: string[] = [];
const previousSpawnfileHome = process.env.SPAWNFILE_HOME;
const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousGithubToken = process.env.GH_TOKEN;

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

const createTeamProject = async (
  manifestLines: string[],
  agentManifestLines: string[] = [
    'spawnfile_version: "0.1"',
    "kind: agent",
    "name: leader",
    "",
    "runtime: openclaw",
    "",
    "workspace:",
    "  docs:",
    "    system: AGENTS.md",
    ""
  ]
): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-auth-sync-team-");
  await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
  await ensureDirectory(path.join(directory, "agents", "leader"));
  await writeUtf8File(path.join(directory, "agents", "leader", "AGENTS.md"), "# Leader\n");
  await writeUtf8File(path.join(directory, "agents", "leader", "Spawnfile"), `${agentManifestLines.join("\n")}\n`);
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

  if (previousGithubToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = previousGithubToken;
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
      "workspace:",
      "  docs:",
      "    system: AGENTS.md"
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
      "workspace:",
      "  docs:",
      "    system: AGENTS.md"
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
      "workspace:",
      "  docs:",
      "    system: AGENTS.md"
    ]);

    await expect(
      syncProjectAuth(projectDirectory, {
        profileName: "dev"
      })
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "Missing required auth env: OPENAI_API_KEY"
    });
  });

  it("captures custom API-key env names declared inline on model targets", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await writeUtf8File(path.join(envDirectory, ".env"), "CUSTOM_API_KEY=custom-token\n");

    const projectDirectory = await createAgentProject([
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: auth-sync",
      "",
      "runtime: picoclaw",
      "",
      "execution:",
      "  model:",
      "    primary:",
      "      provider: custom",
      "      name: foo-large",
      "      auth:",
      "        method: api_key",
      "        key: CUSTOM_API_KEY",
      "      endpoint:",
      "        compatibility: openai",
      "        base_url: https://llm.example.com/v1",
      "",
      "workspace:",
      "  docs:",
      "    system: AGENTS.md"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      CUSTOM_API_KEY: "custom-token"
    });
  });

  it("captures Discord surface env names even without model API-key auth", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await writeUtf8File(path.join(envDirectory, ".env"), "DISCORD_BOT_TOKEN=discord-token\n");

    const projectDirectory = await createAgentProject([
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: auth-sync",
      "",
      "runtime: openclaw",
      "",
      "surfaces:",
      "  discord: {}",
      "",
      "workspace:",
      "  docs:",
      "    system: AGENTS.md"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      DISCORD_BOT_TOKEN: "discord-token"
    });
  });

  it("captures Telegram surface env names even without model API-key auth", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await writeUtf8File(path.join(envDirectory, ".env"), "TELEGRAM_BOT_TOKEN=telegram-token\n");

    const projectDirectory = await createAgentProject([
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: auth-sync",
      "",
      "runtime: openclaw",
      "",
      "surfaces:",
      "  telegram: {}",
      "",
      "workspace:",
      "  docs:",
      "    system: AGENTS.md"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      TELEGRAM_BOT_TOKEN: "telegram-token"
    });
  });

  it("captures declared project secrets from env files", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await writeUtf8File(
      path.join(envDirectory, ".env"),
      "GH_TOKEN=github-token\nOPTIONAL_REPORTING_TOKEN=optional-token\n"
    );

    const projectDirectory = await createAgentProject([
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: auth-sync",
      "",
      "runtime: picoclaw",
      "",
      "environment:",
      "  secrets:",
      "  - name: GH_TOKEN",
      "    required: true",
      "  - name: OPTIONAL_REPORTING_TOKEN",
      "    required: false",
      "",
      "workspace:",
      "  docs:",
      "    system: AGENTS.md"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      GH_TOKEN: "github-token",
      OPTIONAL_REPORTING_TOKEN: "optional-token"
    });
  });

  it("syncs auth for team projects by collecting shared secrets and member requirements", async () => {
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
      "ANTHROPIC_API_KEY=file-anthropic\nOPENAI_API_KEY=file-openai\nSEARCH_API_KEY=file-search\n"
    );

    const profile = await syncProjectAuth(
      await createTeamProject(
        [
          'spawnfile_version: "0.1"',
          "kind: team",
          "name: research-cell",
          "",
          "shared:",
          "  workspace:",
          "    docs:",
          "      system: TEAM.md",
          "  environment:",
          "    secrets:",
          "      - name: SEARCH_API_KEY",
          "        required: true",
          "",
          "mode: hierarchical",
          "lead: leader",
          "",
          "members:",
          "  - id: leader",
          "    ref: ./agents/leader",
          ""
        ],
        [
          'spawnfile_version: "0.1"',
          "kind: agent",
          "name: leader",
          "",
          "runtime: openclaw",
          "",
          "execution:",
          "  model:",
          "    primary:",
          "      provider: anthropic",
          "      name: claude-sonnet-4-5",
          "      auth:",
          "        method: claude-code",
          "",
          "workspace:",
          "  docs:",
          "    system: AGENTS.md",
          ""
        ]
      ),
      {
      claudeCodeDirectory: claudeHome,
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      SEARCH_API_KEY: "file-search"
    });
    expect(profile.imports["claude-code"]).toBeDefined();
    expect(profile.imports.codex).toBeUndefined();
  });

  it("collects MCP server secrets from the effective agent environment", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await writeUtf8File(
      path.join(envDirectory, ".env"),
      "MCP_SEARCH_API_KEY=from-mcp\n"
    );

    const projectDirectory = await createAgentProject([
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: auth-sync",
      "",
      "runtime: openclaw",
      "",
      "environment:",
      "  mcp_servers:",
      "    - name: web_search",
      "      transport: streamable_http",
      "      url: https://search.mcp.example.com/mcp",
      "      auth:",
      "        secret: MCP_SEARCH_API_KEY",
      "",
      "workspace:",
      "  docs:",
      "    system: AGENTS.md"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      MCP_SEARCH_API_KEY: "from-mcp"
    });
  });

  it("collects MCP server secrets from shared team environment", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await writeUtf8File(
      path.join(envDirectory, ".env"),
      "TEAM_MCP_TOKEN=team-mcp-token\n"
    );

    const profile = await syncProjectAuth(
      await createTeamProject(
        [
          'spawnfile_version: "0.1"',
          "kind: team",
          "name: research-cell",
          "",
          "shared:",
          "  workspace:",
          "    docs:",
          "      system: TEAM.md",
          "  environment:",
          "    mcp_servers:",
          "      - name: github",
          "        transport: stdio",
          "        command: /bin/gh-mcp",
          "        auth:",
          "          secret: TEAM_MCP_TOKEN",
          "",
          "mode: hierarchical",
          "lead: leader",
          "",
          "members:",
          "  - id: leader",
          "    ref: ./agents/leader",
          ""
        ],
        [
          'spawnfile_version: "0.1"',
          "kind: agent",
          "name: leader",
          "",
          "runtime: openclaw",
          "",
          "workspace:",
          "  docs:",
          "    system: AGENTS.md"
        ]
      ),
      {
        envFilePath: path.join(envDirectory, ".env"),
        profileName: "dev"
      }
    );

    expect(profile.env).toEqual({
      TEAM_MCP_TOKEN: "team-mcp-token"
    });
  });

  it("collects managed Moltnet secrets, including bearer/open tokens, DSN, and pairings", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await writeUtf8File(
      path.join(envDirectory, ".env"),
      [
        "MOLTNET_ATTACH_TOKEN=bearer-token\n",
        "REMOTE_NET_PAIR_TOKEN=pair-token\n",
        "MOLTNET_DATABASE_URL=postgres-dsn\n",
        "MOLTNET_OPEN_STATIC_TOKEN=open-static-token\n"
      ].join("")
    );

    const projectDirectory = await createTeamProject([
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: mesh",
      "",
      "shared:",
      "  workspace:",
      "    docs:",
      "      system: TEAM.md",
      "",
      "mode: hierarchical",
      "lead: leader",
      "",
      "members:",
      "  - id: leader",
      "    ref: ./agents/leader",
      "",
      "networks:",
      "  - id: managed-bearer",
      "    provider: moltnet",
      "    rooms:",
      "      - id: control",
      "        members: [leader]",
      "    server:",
      "      mode: managed",
      "      listen:",
      "        bind: 127.0.0.1",
      "        port: 8888",
      "      auth:",
      "        mode: bearer",
      "        tokens:",
      "          - id: attachments",
      "            secret: MOLTNET_ATTACH_TOKEN",
      "            scopes: [attach, write, observe]",
      "        client:",
      "          token_id: attachments",
      "      pairings:",
      "        - id: remote-link",
      "          remote_base_url: https://remote.example.com",
      "          remote_network_id: remote",
      "          remote_network_name: Remote",
      "          token_secret: REMOTE_NET_PAIR_TOKEN",
      "      store:",
      "        kind: postgres",
      "        dsn_secret: MOLTNET_DATABASE_URL",
      "",
      "  - id: managed-open",
      "    provider: moltnet",
      "    rooms:",
      "      - id: control",
      "        members: [leader]",
      "    server:",
      "      mode: managed",
      "      listen:",
      "        bind: 127.0.0.1",
      "        port: 8889",
      "      auth:",
      "        mode: open",
      "        tokens:",
      "          - id: shared-attach",
      "            secret: MOLTNET_OPEN_STATIC_TOKEN",
      "            scopes: [attach, write]",
      "            agents: [leader]",
      "        client:",
      "          token_id: shared-attach",
      "          static_token: true",
      "      store:",
      "        kind: sqlite",
      "        path: /tmp/moltnet-open.sqlite"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      MOLTNET_ATTACH_TOKEN: "bearer-token",
      MOLTNET_DATABASE_URL: "postgres-dsn",
      MOLTNET_OPEN_STATIC_TOKEN: "open-static-token",
      REMOTE_NET_PAIR_TOKEN: "pair-token"
    });
  });

  it("collects external bearer token_env secrets", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    const envDirectory = await createTempDirectory("spawnfile-env-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;
    await writeUtf8File(
      path.join(envDirectory, ".env"),
      "MOLTNET_EXTERNAL_TOKEN=external-token\n"
    );

    const projectDirectory = await createTeamProject([
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: mesh",
      "",
      "shared:",
      "  workspace:",
      "    docs:",
      "      system: TEAM.md",
      "",
      "mode: hierarchical",
      "lead: leader",
      "",
      "members:",
      "  - id: leader",
      "    ref: ./agents/leader",
      "",
      "networks:",
      "  - id: remote-external",
      "    provider: moltnet",
      "    rooms:",
      "      - id: control",
      "        members: [leader]",
      "    server:",
      "      mode: external",
      "      url: https://moltnet.example.com",
      "      auth:",
      "        mode: bearer",
      "        client:",
      "          token_env: MOLTNET_EXTERNAL_TOKEN"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      envFilePath: path.join(envDirectory, ".env"),
      profileName: "dev"
    });

    expect(profile.env).toEqual({
      MOLTNET_EXTERNAL_TOKEN: "external-token"
    });
  });

  it("does not collect generated open self-claim token paths", async () => {
    const spawnfileHome = await createTempDirectory("spawnfile-auth-home-");
    process.env.SPAWNFILE_HOME = spawnfileHome;

    const projectDirectory = await createTeamProject([
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: mesh",
      "",
      "shared:",
      "  workspace:",
      "    docs:",
      "      system: TEAM.md",
      "",
      "mode: hierarchical",
      "lead: leader",
      "",
      "members:",
      "  - id: leader",
      "    ref: ./agents/leader",
      "",
      "networks:",
      "  - id: managed-open",
      "    provider: moltnet",
      "    rooms:",
      "      - id: control",
      "        members: [leader]",
      "    server:",
      "      mode: managed",
      "      listen:",
      "        bind: 127.0.0.1",
      "        port: 8890",
      "      auth:",
      "        mode: open",
      "      store:",
      "        kind: sqlite",
      "        path: /tmp/moltnet-open.sqlite"
    ]);

    const profile = await syncProjectAuth(projectDirectory, {
      profileName: "dev"
    });

    expect(profile.env).toEqual({});
  });
});
