import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../../compiler/types.js";

import { tinyClawAdapter } from "./adapter.js";

describe("tinyClawAdapter", () => {
  it("exposes container metadata for API boot", () => {
    expect(tinyClawAdapter.container).toEqual({
      configFileName: "settings.json",
      configEnvBindings: [
        {
          envName: "ANTHROPIC_API_KEY",
          jsonPath: "models.anthropic.api_key"
        },
        {
          envName: "OPENAI_API_KEY",
          jsonPath: "models.openai.api_key"
        }
      ],
      homeEnv: "TINYAGI_HOME",
      globalNpmPackages: ["@anthropic-ai/claude-code", "@openai/codex"],
      instancePaths: {
        configPathTemplate: "<instance-root>/tinyagi/<config-file>",
        homePathTemplate: "<instance-root>/tinyagi",
        sourceWorkspacePathTemplate: "<instance-root>/workspace/<agent-name>",
        workspacePathTemplate: "<instance-root>/workspace"
      },
      port: 3777,
      portEnv: "TINYAGI_API_PORT",
      standaloneBaseImage: "node:22-bookworm-slim",
      startCommand: [
        "bash",
        "-lc",
        expect.stringContaining("node <runtime-root>/packages/channels/dist/discord.js")
      ],
      systemDeps: ["bash", "ca-certificates", "curl", "g++", "make", "python3", "tar"]
    });
    expect(
      tinyClawAdapter.container.startCommand[2]
    ).toContain("node <runtime-root>/packages/channels/dist/telegram.js");
  });

  it("resolves the system instruction surface from the agent name", () => {
    const node: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent",
      mcpServers: [],
      name: "field-researcher",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/field-researcher/Spawnfile",
      subagents: []
    };

    expect(tinyClawAdapter.systemInstructionSurface?.placement).toBe("append_pointer");
    expect(tinyClawAdapter.systemInstructionSurface?.resolvePath({ node })).toBe(
      "workspace/field-researcher/AGENTS.md"
    );
  });

  it("emits settings.json with agents map and workspace", async () => {
    const node: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/Spawnfile",
      subagents: []
    };

    const result = await tinyClawAdapter.compileAgent(node);
    const configFile = result.files.find((file) => file.path === "settings.json");
    expect(configFile).toBeTruthy();

    const config = JSON.parse(configFile!.content);
    expect(config.agents.assistant.provider).toBe("anthropic");
    expect(config.agents.assistant.model).toBe("claude-sonnet-4-5");
    expect(config.workspace).toBeTruthy();
    expect(config.agent).toBeUndefined();
  });

  it("lowers cron schedules into TinyClaw schedules.json", async () => {
    const node: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            auth: { method: "none" },
            name: "noop",
            provider: "opencode"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "scheduled",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      schedule: {
        cron: "* * * * *",
        kind: "cron",
        prompt: "check the room"
      },
      secrets: [],
      skills: [],
      source: "/tmp/scheduled/Spawnfile",
      subagents: []
    };

    const compiled = await tinyClawAdapter.compileAgent(node);
    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: compiled.files,
        id: "agent:scheduled",
        kind: "agent",
        slug: "scheduled",
        value: node
      }
    ]);

    const schedulesFile = targets?.[0]?.files.find((file) => file.path === "home/schedules.json");
    const schedules = JSON.parse(schedulesFile?.content ?? "[]");

    expect(schedules).toEqual([
      {
        agentId: "scheduled",
        channel: "schedule",
        createdAt: 0,
        cron: "* * * * *",
        enabled: true,
        id: "spawnfile-scheduled",
        label: "Spawnfile schedule for scheduled",
        message: "check the room",
        sender: "Spawnfile Scheduler"
      }
    ]);
    expect(
      compiled.capabilities.find((capability) => capability.key === "agent.schedule")?.outcome
    ).toBe("supported");
  });

  it("degrades every schedules because TinyClaw only lowers cron natively", async () => {
    const node: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent",
      mcpServers: [],
      name: "scheduled",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      schedule: {
        every: "2h",
        kind: "every"
      },
      secrets: [],
      skills: [],
      source: "/tmp/scheduled/Spawnfile",
      subagents: []
    };

    const result = await tinyClawAdapter.compileAgent(node);

    expect(
      result.capabilities.find((capability) => capability.key === "agent.schedule")?.outcome
    ).toBe("degraded");
    expect(result.diagnostics).toEqual([
      {
        level: "warn",
        message: expect.stringContaining("every schedules are degraded")
      }
    ]);
  });

  it("emits Discord channel settings when Discord is declared", async () => {
    const node: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/Spawnfile",
      subagents: [],
      surfaces: {
        discord: {
          botTokenSecret: "TEAM_DISCORD_TOKEN"
        }
      }
    };

    const result = await tinyClawAdapter.compileAgent(node);
    const config = JSON.parse(result.files.find((file) => file.path === "settings.json")!.content);

    expect(config.channels).toEqual({
      discord: {},
      enabled: ["discord"]
    });
    expect(
      result.capabilities.find((capability) => capability.key === "surfaces.discord")?.outcome
    ).toBe("supported");
  });

  it("emits Telegram channel settings when Telegram is declared", async () => {
    const node: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/Spawnfile",
      subagents: [],
      surfaces: {
        telegram: {
          botTokenSecret: "TEAM_TELEGRAM_TOKEN"
        }
      }
    };

    const result = await tinyClawAdapter.compileAgent(node);
    const config = JSON.parse(result.files.find((file) => file.path === "settings.json")!.content);

    expect(config.channels).toEqual({
      enabled: ["telegram"],
      telegram: {}
    });
    expect(
      result.capabilities.find((capability) => capability.key === "surfaces.telegram")?.outcome
    ).toBe("supported");
  });

  it("marks MCP as degraded when MCP servers are declared", async () => {
    const node: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent",
      mcpServers: [{ name: "web_search", transport: "streamable_http", url: "https://example.com" }],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/Spawnfile",
      subagents: []
    };

    const result = await tinyClawAdapter.compileAgent(node);
    expect(result.capabilities.find((capability) => capability.key === "mcp.web_search")?.outcome).toBe(
      "degraded"
    );
  });

  it("compiles a native team artifact with teams map", async () => {
    const result = await tinyClawAdapter.compileTeam?.({
      description: "",
      docs: [],
      external: ["leader"],
      kind: "team",
      lead: "leader",
      members: [
        { id: "leader", kind: "agent", nodeSource: "/tmp/a", runtimeName: "tinyclaw" },
        { id: "writer", kind: "agent", nodeSource: "/tmp/b", runtimeName: "tinyclaw" }
      ],
      mode: "hierarchical" as const,
      name: "research-cell",
      policyMode: null,
      policyOnDegrade: null,
      shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
      source: "/tmp/team/Spawnfile"
    });

    const configFile = result?.files[0];
    expect(configFile?.path).toBe("tinyclaw-team.json");

    const config = JSON.parse(configFile!.content);
    expect(config.teams["research-cell"].leader_agent).toBe("leader");
    expect(config.teams["research-cell"].agents).toEqual(["leader", "writer"]);
  });

  it("does not invent a TinyClaw leader when no direct agent lead is declared", async () => {
    const result = await tinyClawAdapter.compileTeam?.({
      description: "",
      docs: [],
      external: [],
      kind: "team",
      lead: null,
      members: [
        { id: "writer", kind: "agent", nodeSource: "/tmp/b", runtimeName: "tinyclaw" },
        { id: "reviewer", kind: "agent", nodeSource: "/tmp/c", runtimeName: "tinyclaw" }
      ],
      mode: "swarm" as const,
      name: "research-cell",
      policyMode: null,
      policyOnDegrade: null,
      shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
      source: "/tmp/team/Spawnfile"
    });

    const config = JSON.parse(result!.files[0]!.content);
    expect(config.teams["research-cell"].leader_agent).toBeUndefined();
    expect(result?.capabilities.find((capability) => capability.key === "team.lead")?.outcome).toBe(
      "degraded"
    );
  });

  it("merges agent and team artifacts into one container target", async () => {
    const assistantNode: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/assistant/Spawnfile",
      subagents: []
    };
    const writerNode: ResolvedAgentNode = {
      ...assistantNode,
      name: "writer",
      source: "/tmp/writer/Spawnfile"
    };

    const assistantFiles = await tinyClawAdapter.compileAgent(assistantNode);
    const writerFiles = await tinyClawAdapter.compileAgent(writerNode);
    const teamFiles = await tinyClawAdapter.compileTeam?.({
      description: "",
      docs: [],
      external: [],
      kind: "team",
      lead: "assistant",
      members: [
        { id: "assistant", kind: "agent", nodeSource: "/tmp/a", runtimeName: "tinyclaw" },
        { id: "writer", kind: "agent", nodeSource: "/tmp/b", runtimeName: "tinyclaw" }
      ],
      mode: "hierarchical" as const,
      name: "research-cell",
      policyMode: null,
      policyOnDegrade: null,
      shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
      source: "/tmp/team/Spawnfile"
    });

    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: assistantFiles.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: assistantNode
      },
      {
        emittedFiles: writerFiles.files,
        id: "agent:writer",
        kind: "agent",
        slug: "writer",
        value: writerNode
      },
      {
        emittedFiles: teamFiles?.files ?? [],
        id: "team:research-cell",
        kind: "team",
        slug: "research-cell",
        value: {
          description: "",
          docs: [],
          external: [],
          kind: "team",
          lead: "assistant",
          members: [
            { id: "assistant", kind: "agent", nodeSource: "/tmp/a", runtimeName: "tinyclaw" },
            { id: "writer", kind: "agent", nodeSource: "/tmp/b", runtimeName: "tinyclaw" }
          ],
          mode: "hierarchical" as const,
          name: "research-cell",
          policyMode: null,
          policyOnDegrade: null,
          shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
          source: "/tmp/team/Spawnfile"
        }
      }
    ]);

    expect(targets).toHaveLength(1);
    expect(targets?.[0]?.id).toBe("tinyclaw-runtime");

    const settingsFile = targets?.[0]?.files.find((file) => file.path === "settings.json");
    const settings = JSON.parse(settingsFile?.content ?? "{}");
    expect(Object.keys(settings.agents)).toEqual(["assistant", "writer"]);
    expect(settings.teams["research-cell"].leader_agent).toBe("assistant");
  });

  it("declares a merged Discord token binding for runtime targets", async () => {
    const assistantNode: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/assistant/Spawnfile",
      subagents: [],
      surfaces: {
        discord: {
          botTokenSecret: "TEAM_DISCORD_TOKEN"
        }
      }
    };
    const writerNode: ResolvedAgentNode = {
      ...assistantNode,
      name: "writer",
      source: "/tmp/writer/Spawnfile"
    };

    const assistantFiles = await tinyClawAdapter.compileAgent(assistantNode);
    const writerFiles = await tinyClawAdapter.compileAgent(writerNode);
    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: assistantFiles.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: assistantNode
      },
      {
        emittedFiles: writerFiles.files,
        id: "agent:writer",
        kind: "agent",
        slug: "writer",
        value: writerNode
      }
    ]);

    expect(targets?.[0]?.configEnvBindings).toEqual([
      {
        envName: "TEAM_DISCORD_TOKEN",
        jsonPath: "channels.discord.bot_token"
      }
    ]);
  });

  it("declares merged Discord and Telegram token bindings for runtime targets", async () => {
    const assistantNode: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/assistant/Spawnfile",
      subagents: [],
      surfaces: {
        discord: {
          botTokenSecret: "TEAM_DISCORD_TOKEN"
        },
        telegram: {
          botTokenSecret: "TEAM_TELEGRAM_TOKEN"
        }
      }
    };

    const assistantFiles = await tinyClawAdapter.compileAgent(assistantNode);
    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: assistantFiles.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: assistantNode
      }
    ]);

    expect(targets?.[0]?.configEnvBindings).toEqual([
      {
        envName: "TEAM_DISCORD_TOKEN",
        jsonPath: "channels.discord.bot_token"
      },
      {
        envName: "TEAM_TELEGRAM_TOKEN",
        jsonPath: "channels.telegram.bot_token"
      }
    ]);
  });

  it("rejects conflicting Discord bot token secrets across merged agents", async () => {
    const assistantNode: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/assistant/Spawnfile",
      subagents: [],
      surfaces: {
        discord: {
          botTokenSecret: "DISCORD_ONE"
        }
      }
    };
    const writerNode: ResolvedAgentNode = {
      ...assistantNode,
      name: "writer",
      source: "/tmp/writer/Spawnfile",
      surfaces: {
        discord: {
          botTokenSecret: "DISCORD_TWO"
        }
      }
    };

    const assistantFiles = await tinyClawAdapter.compileAgent(assistantNode);
    const writerFiles = await tinyClawAdapter.compileAgent(writerNode);

    await expect(
      tinyClawAdapter.createContainerTargets?.([
        {
          emittedFiles: assistantFiles.files,
          id: "agent:assistant",
          kind: "agent",
          slug: "assistant",
          value: assistantNode
        },
        {
          emittedFiles: writerFiles.files,
          id: "agent:writer",
          kind: "agent",
          slug: "writer",
          value: writerNode
        }
      ]) ?? Promise.resolve([])
    ).rejects.toThrow(/conflicting Discord bot token secrets/);
  });

  it("rejects conflicting Telegram bot token secrets across merged agents", async () => {
    const assistantNode: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: {
        model: {
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/assistant/Spawnfile",
      subagents: [],
      surfaces: {
        telegram: {
          botTokenSecret: "TELEGRAM_ONE"
        }
      }
    };
    const writerNode: ResolvedAgentNode = {
      ...assistantNode,
      name: "writer",
      source: "/tmp/writer/Spawnfile",
      surfaces: {
        telegram: {
          botTokenSecret: "TELEGRAM_TWO"
        }
      }
    };

    const assistantFiles = await tinyClawAdapter.compileAgent(assistantNode);
    const writerFiles = await tinyClawAdapter.compileAgent(writerNode);

    await expect(
      tinyClawAdapter.createContainerTargets?.([
        {
          emittedFiles: assistantFiles.files,
          id: "agent:assistant",
          kind: "agent",
          slug: "assistant",
          value: assistantNode
        },
        {
          emittedFiles: writerFiles.files,
          id: "agent:writer",
          kind: "agent",
          slug: "writer",
          value: writerNode
        }
      ]) ?? Promise.resolve([])
    ).rejects.toThrow(/conflicting telegram bot token secrets/i);
  });

  it("returns no container targets when no agent artifacts are present", async () => {
    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: [],
        id: "team:research-cell",
        kind: "team",
        slug: "research-cell",
        value: {
          description: "",
          docs: [],
          external: [],
          kind: "team",
          lead: null,
          members: [],
          mode: "swarm" as const,
          name: "research-cell",
          policyMode: null,
          policyOnDegrade: null,
          shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
          source: "/tmp/team/Spawnfile"
        }
      }
    ]);

    expect(targets).toEqual([]);
  });

  it("validates supported and unsupported model target combinations", () => {
    expect(() =>
      tinyClawAdapter.assertSupportedModelTarget({
        auth: { method: "claude-code" },
        name: "claude-opus-4-6",
        provider: "anthropic"
      })
    ).not.toThrow();

    expect(() =>
      tinyClawAdapter.assertSupportedModelTarget({
        auth: { method: "codex" },
        name: "gpt-5.4",
        provider: "openai"
      })
    ).not.toThrow();

    expect(() =>
      tinyClawAdapter.assertSupportedModelTarget({
        auth: { method: "none" },
        name: "opencode/claude-sonnet-4-6",
        provider: "opencode"
      })
    ).not.toThrow();

    expect(() =>
      tinyClawAdapter.assertSupportedModelTarget({
        auth: { method: "api_key" },
        name: "gpt-5.4",
        provider: "openai"
      })
    ).not.toThrow();

    expect(() =>
      tinyClawAdapter.assertSupportedModelTarget({
        auth: { method: "api_key" },
        name: "claude-opus-4-6",
        provider: "anthropic"
      })
    ).not.toThrow();

    expect(() =>
      tinyClawAdapter.assertSupportedModelTarget({
        auth: { method: "api_key" },
        endpoint: {
          base_url: "https://llm.example.com/v1",
          compatibility: "openai"
        },
        name: "foo-large",
        provider: "custom"
      })
    ).toThrow(/custom or local endpoints are not supported/);

    expect(() =>
      tinyClawAdapter.assertSupportedModelTarget({
        auth: { method: "api_key" },
        name: "gpt-4o",
        provider: "openai"
      })
    ).toThrow(/Codex\/GPT-5 path/);
  });

  it("rejects unsupported Discord access modes and allowlist fields", () => {
    expect(() =>
      tinyClawAdapter.assertSupportedSurfaces?.({
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "allowlist",
            users: ["987654321098765432"]
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      })
    ).toThrow(/only supports pairing access/);

    expect(() =>
      tinyClawAdapter.assertSupportedSurfaces?.({
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "pairing",
            users: ["987654321098765432"]
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      })
    ).toThrow(/does not support declarative users, guilds, or channels/);
  });

  it("ignores team inputs without a native team artifact when merging container targets", async () => {
    const node: ResolvedAgentNode = {
      description: "",
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent",
      mcpServers: [],
      name: "assistant",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/assistant/Spawnfile",
      subagents: []
    };

    const compiled = await tinyClawAdapter.compileAgent(node);
    const targets = await tinyClawAdapter.createContainerTargets?.([
      {
        emittedFiles: compiled.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: node
      },
      {
        emittedFiles: [],
        id: "team:research-cell",
        kind: "team",
        slug: "research-cell",
        value: {
          description: "",
          docs: [],
          external: [],
          kind: "team",
          lead: "assistant",
          members: [{ id: "assistant", kind: "agent", nodeSource: "/tmp/a", runtimeName: "tinyclaw" }],
          mode: "hierarchical" as const,
          name: "research-cell",
          policyMode: null,
          policyOnDegrade: null,
          shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
          source: "/tmp/team/Spawnfile"
        }
      }
    ]);

    const settings = JSON.parse(
      targets?.[0]?.files.find((file) => file.path === "settings.json")?.content ?? "{}"
    );
    expect(settings.teams).toBeUndefined();
  });
});
