import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../../compiler/types.js";

import { picoClawAdapter } from "./adapter.js";

const node: ResolvedAgentNode = {
  docs: [],
  env: {},
  execution: {
    model: {
      primary: {
        name: "gpt-4o-mini",
        provider: "openai"
      }
    }
  },
  kind: "agent",
  mcpServers: [{ name: "local", transport: "stdio", command: "node" }],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "picoclaw", options: { restrict_to_workspace: true } },
  secrets: [],
  skills: [],
  source: "/tmp/Spawnfile",
  subagents: []
};

describe("picoClawAdapter", () => {
  it("exposes container metadata for gateway boot", () => {
    expect(picoClawAdapter.container).toEqual({
      configFileName: "config.json",
      configPathEnv: "PICOCLAW_CONFIG",
      globalNpmPackages: ["@anthropic-ai/claude-code", "@openai/codex"],
      homeEnv: "PICOCLAW_HOME",
      instancePaths: {
        configPathTemplate: "<instance-root>/picoclaw/<config-file>",
        homePathTemplate: "<instance-root>/picoclaw",
        workspacePathTemplate: "<instance-root>/picoclaw/workspace"
      },
      port: 18790,
      portEnv: "PICOCLAW_GATEWAY_PORT",
      standaloneBaseImage: "debian:bookworm-slim",
      startCommand: ["picoclaw", "gateway", "--allow-empty"],
      staticEnv: {
        PICOCLAW_GATEWAY_HOST: "0.0.0.0"
      },
      systemDeps: ["bash", "ca-certificates", "curl", "nodejs", "npm", "tar"]
    });
  });

  it("emits config with agents.defaults and model_list", async () => {
    const result = await picoClawAdapter.compileAgent(node);
    const configFile = result.files.find((file) => file.path === "config.json");
    expect(configFile).toBeTruthy();

    const config = JSON.parse(configFile!.content);
    expect(config.agents.defaults.model_name).toBe("gpt-4o-mini");
    expect(config.agents.defaults.restrict_to_workspace).toBe(true);
    expect(config.agents.defaults.temperature).toBeUndefined();
    expect(config.model_list[0].model).toBe("openai/gpt-4o-mini");
    expect(config.model_list[0].api_key).toBe("file://secrets/OPENAI_API_KEY");
    expect(config.model).toBeUndefined();
  });

  it("emits explicit temperature for openai gpt-5", async () => {
    const result = await picoClawAdapter.compileAgent({
      ...node,
      execution: {
        model: {
          primary: {
            name: "gpt-5",
            provider: "openai"
          }
        }
      }
    });

    const config = JSON.parse(result.files.find((file) => file.path === "config.json")!.content);
    expect(config.agents.defaults.model_name).toBe("gpt-5");
    expect(config.agents.defaults.temperature).toBe(1);
  });

  it("emits Discord channel config and token binding when Discord is declared", async () => {
    const discordNode: ResolvedAgentNode = {
      ...node,
      surfaces: {
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "allowlist",
            users: ["987654321098765432"]
          },
          botTokenSecret: "TEAM_DISCORD_TOKEN"
        }
      }
    };
    const compiled = await picoClawAdapter.compileAgent(discordNode);
    const config = JSON.parse(compiled.files.find((file) => file.path === "config.json")!.content);
    const [target] = await picoClawAdapter.createContainerTargets?.([
      {
        emittedFiles: compiled.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: discordNode
      }
    ]) ?? [];

    expect(config.channels.discord).toEqual({
      allow_from: ["987654321098765432"],
      enabled: true,
      mention_only: true
    });
    expect(target?.configEnvBindings).toEqual([
      {
        envName: "TEAM_DISCORD_TOKEN",
        jsonPath: "channels.discord.token"
      }
    ]);
  });

  it("emits open Discord access without user allowlists", async () => {
    const discordNode: ResolvedAgentNode = {
      ...node,
      surfaces: {
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "open",
            users: []
          },
          botTokenSecret: "TEAM_DISCORD_TOKEN"
        }
      }
    };
    const compiled = await picoClawAdapter.compileAgent(discordNode);
    const config = JSON.parse(compiled.files.find((file) => file.path === "config.json")!.content);

    expect(config.channels.discord).toEqual({
      enabled: true,
      mention_only: true
    });
  });

  it("emits Telegram channel config and token binding when Telegram is declared", async () => {
    const telegramNode: ResolvedAgentNode = {
      ...node,
      surfaces: {
        telegram: {
          access: {
            chats: [],
            mode: "allowlist",
            users: ["123456789"]
          },
          botTokenSecret: "TEAM_TELEGRAM_TOKEN"
        }
      }
    };
    const compiled = await picoClawAdapter.compileAgent(telegramNode);
    const config = JSON.parse(compiled.files.find((file) => file.path === "config.json")!.content);
    const [target] = await picoClawAdapter.createContainerTargets?.([
      {
        emittedFiles: compiled.files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: telegramNode
      }
    ]) ?? [];

    expect(config.channels.telegram).toEqual({
      allow_from: ["123456789"],
      enabled: true
    });
    expect(target?.configEnvBindings).toEqual([
      {
        envName: "TEAM_TELEGRAM_TOKEN",
        jsonPath: "channels.telegram.token"
      }
    ]);
  });

  it("emits MCP servers as named map", async () => {
    const result = await picoClawAdapter.compileAgent(node);
    const config = JSON.parse(result.files.find((file) => file.path === "config.json")!.content);
    expect(config.tools.mcp.enabled).toBe(true);
    expect(config.tools.mcp.servers.local.command).toBe("node");
  });

  it("emits fallback models and http MCP servers", async () => {
    const result = await picoClawAdapter.compileAgent({
      ...node,
      execution: {
        model: {
          fallback: [{ name: "claude-sonnet-4-5", provider: "anthropic" }],
          primary: {
            name: "gpt-4o-mini",
            provider: "openai"
          }
        }
      },
      mcpServers: [
        {
          auth: { secret: "SEARCH_API_KEY" },
          name: "web",
          transport: "streamable_http",
          url: "https://example.com/mcp"
        }
      ]
    });

    const config = JSON.parse(result.files.find((file) => file.path === "config.json")!.content);
    expect(config.model_list).toHaveLength(2);
    expect(config.model_list[1].model).toBe("anthropic/claude-sonnet-4-5");
    expect(config.model_list[1].api_key).toBe("file://secrets/ANTHROPIC_API_KEY");
    expect(config.tools.mcp.servers.web.type).toBe("http");
    expect(config.tools.mcp.servers.web.url).toBe("https://example.com/mcp");
    expect(config.tools.mcp.servers.web.headers.SEARCH_API_KEY).toBe("");
  });

  it("emits custom and local endpoint models with explicit compatibility", async () => {
    const result = await picoClawAdapter.compileAgent({
      ...node,
      execution: {
        model: {
          fallback: [
            {
              auth: {
                method: "none"
              },
              endpoint: {
                base_url: "http://host.docker.internal:11434/v1",
                compatibility: "openai"
              },
              name: "qwen2.5:14b",
              provider: "local"
            }
          ],
          primary: {
            auth: {
              key: "CUSTOM_API_KEY",
              method: "api_key"
            },
            endpoint: {
              base_url: "https://llm.example.com/v1",
              compatibility: "anthropic"
            },
            name: "foo-large",
            provider: "custom"
          }
        }
      }
    });

    const config = JSON.parse(result.files.find((file) => file.path === "config.json")!.content);
    expect(config.model_list).toEqual([
      {
        api_base: "https://llm.example.com/v1",
        api_key: "file://secrets/CUSTOM_API_KEY",
        model: "anthropic-messages/foo-large",
        model_name: "foo-large"
      },
      {
        api_base: "http://host.docker.internal:11434/v1",
        model: "openai/qwen2.5:14b",
        model_name: "qwen2.5:14b"
      }
    ]);
  });

  it("declares per-target provider secret files for container boot", async () => {
    const [target] = await picoClawAdapter.createContainerTargets?.([
      {
        emittedFiles: (await picoClawAdapter.compileAgent({
          ...node,
          execution: {
            model: {
              fallback: [{ name: "claude-sonnet-4-5", provider: "anthropic" }],
              primary: {
                name: "gpt-4o-mini",
                provider: "openai"
              }
            }
          }
        })).files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: {
          ...node,
          execution: {
            model: {
              fallback: [{ name: "claude-sonnet-4-5", provider: "anthropic" }],
              primary: {
                name: "gpt-4o-mini",
                provider: "openai"
              }
            }
          }
        }
      }
    ]) ?? [];

    expect(target?.envFiles).toEqual([
      { envName: "ANTHROPIC_API_KEY", relativePath: "secrets/ANTHROPIC_API_KEY" },
      { envName: "OPENAI_API_KEY", relativePath: "secrets/OPENAI_API_KEY" }
    ]);
  });

  it("declares custom API-key secret files for custom endpoints", async () => {
    const [target] = await picoClawAdapter.createContainerTargets?.([
      {
        emittedFiles: (
          await picoClawAdapter.compileAgent({
            ...node,
            execution: {
              model: {
                primary: {
                  auth: {
                    key: "CUSTOM_API_KEY",
                    method: "api_key"
                  },
                  endpoint: {
                    base_url: "https://llm.example.com/v1",
                    compatibility: "openai"
                  },
                  name: "foo-large",
                  provider: "custom"
                }
              }
            }
          })
        ).files,
        id: "agent:assistant",
        kind: "agent",
        slug: "assistant",
        value: {
          ...node,
          execution: {
            model: {
              primary: {
                auth: {
                  key: "CUSTOM_API_KEY",
                  method: "api_key"
                },
                endpoint: {
                  base_url: "https://llm.example.com/v1",
                  compatibility: "openai"
                },
                name: "foo-large",
                provider: "custom"
              }
            }
          }
        }
      }
    ]) ?? [];

    expect(target?.envFiles).toEqual([
      { envName: "CUSTOM_API_KEY", relativePath: "secrets/CUSTOM_API_KEY" }
    ]);
  });

  it("validates supported and unsupported model target combinations", () => {
    expect(() =>
      picoClawAdapter.assertSupportedModelTarget({
        auth: { method: "claude-code" },
        name: "claude-opus-4-6",
        provider: "anthropic"
      })
    ).not.toThrow();

    expect(() =>
      picoClawAdapter.assertSupportedModelTarget({
        auth: { method: "none" },
        endpoint: {
          base_url: "http://host.docker.internal:11434/v1",
          compatibility: "openai"
        },
        name: "qwen2.5:14b",
        provider: "local"
      })
    ).not.toThrow();

    expect(() =>
      picoClawAdapter.assertSupportedModelTarget({
        auth: { method: "none" },
        endpoint: {
          base_url: "https://llm.example.com/v1",
          compatibility: "anthropic"
        },
        name: "foo-large",
        provider: "custom"
      })
    ).toThrow(/require api_key auth/);

    expect(() =>
      picoClawAdapter.assertSupportedModelTarget({
        auth: { method: "codex" },
        endpoint: {
          base_url: "https://llm.example.com/v1",
          compatibility: "openai"
        },
        name: "foo-large",
        provider: "custom"
      })
    ).toThrow(/do not support codex auth/);
  });

  it("validates runtime option types", () => {
    expect(
      picoClawAdapter.validateRuntimeOptions?.({ restrict_to_workspace: "yes" })
    ).toEqual([
      {
        level: "error",
        message: "PicoClaw runtime option restrict_to_workspace must be a boolean"
      }
    ]);
  });

  it("rejects Discord pairing mode and guild or channel allowlists", () => {
    expect(() =>
      picoClawAdapter.assertSupportedSurfaces?.({
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "pairing",
            users: []
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      })
    ).toThrow(/does not support pairing access/);

    expect(() =>
      picoClawAdapter.assertSupportedSurfaces?.({
        discord: {
          access: {
            channels: ["555555555555555555"],
            guilds: ["123456789012345678"],
            mode: "allowlist",
            users: ["987654321098765432"]
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      })
    ).toThrow(/only supports user allowlists/);
  });

  it("rejects Telegram pairing mode and chat allowlists", () => {
    expect(() =>
      picoClawAdapter.assertSupportedSurfaces?.({
        telegram: {
          access: {
            chats: [],
            mode: "pairing",
            users: []
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toThrow(/does not support pairing access/);

    expect(() =>
      picoClawAdapter.assertSupportedSurfaces?.({
        telegram: {
          access: {
            chats: ["-1001234567890"],
            mode: "allowlist",
            users: ["123456789"]
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).toThrow(/only supports user allowlists/);
  });
});
