import { describe, expect, it } from "vitest";

import { ResolvedAgentNode } from "../../compiler/types.js";

import { openClawAdapter } from "./adapter.js";

const createNode = (options: Record<string, unknown> = {}): ResolvedAgentNode => ({
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
  runtime: { name: "openclaw", options },
  secrets: [],
  skills: [],
  source: "/tmp/Spawnfile",
  subagents: [{ id: "critic", nodeSource: "/tmp/subagent/Spawnfile" }]
});

describe("openClawAdapter", () => {
  it("exposes container metadata for gateway boot", () => {
    expect(openClawAdapter.container).toEqual({
      configFileName: "openclaw.json",
      configPathEnv: "OPENCLAW_CONFIG_PATH",
      env: [
        {
          description: "Gateway auth token required for non-loopback OpenClaw access",
          name: "OPENCLAW_GATEWAY_TOKEN",
          required: true
        }
      ],
      homeEnv: "OPENCLAW_HOME",
      instancePaths: {
        configPathTemplate: "<instance-root>/home/.openclaw/<config-file>",
        homePathTemplate: "<instance-root>/home",
        workspacePathTemplate: "<instance-root>/home/.openclaw/workspace"
      },
      port: 18789,
      portStride: 20,
      portEnv: "OPENCLAW_GATEWAY_PORT",
      standaloneBaseImage: "node:24-bookworm-slim",
      startCommand: [
        "node",
        "<runtime-root>/openclaw.mjs",
        "gateway",
        "--allow-unconfigured",
        "--bind",
        "loopback",
        "--port",
        "<port>",
        "--verbose"
      ],
      systemDeps: ["bash", "ca-certificates", "curl", "git", "hostname", "openssl", "procps"]
    });
  });

  it("declares the workspace AGENTS.md system instruction surface", () => {
    expect(openClawAdapter.systemInstructionSurface?.placement).toBe("append_pointer");
    expect(openClawAdapter.systemInstructionSurface?.resolvePath({ node: createNode() })).toBe(
      "workspace/AGENTS.md"
    );
  });

  it("declares adapter-owned live status probes", () => {
    expect(openClawAdapter.statusProbes?.map((probe) => probe.id)).toEqual([
      "home",
      "workspace",
      "config",
      "healthz"
    ]);
  });

  it("emits config with agents.defaults and gateway", async () => {
    const result = await openClawAdapter.compileAgent(createNode());
    const configFile = result.files.find((file) => file.path === "openclaw.json");
    expect(configFile).toBeTruthy();

    const config = JSON.parse(configFile!.content);
    expect(config.agents.defaults.model).toBe("anthropic/claude-sonnet-4-5");
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("loopback");
    expect(config.gateway.auth.mode).toBe("token");
    expect(config.agent).toBeUndefined();
  });

  it("warns when subagents degrade to routed sessions", async () => {
    const result = await openClawAdapter.compileAgent(createNode());

    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.capabilities.find((capability) => capability.key === "agent.subagents")?.outcome).toBe(
      "degraded"
    );
  });

  it("emits Discord channel config when Discord is declared", async () => {
    const result = await openClawAdapter.compileAgent({
      ...createNode(),
      surfaces: {
        discord: {
          access: {
            channels: ["555555555555555555"],
            guilds: ["123456789012345678"],
            mode: "allowlist",
            users: ["987654321098765432"]
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      }
    });

    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);
    expect(config.channels.discord).toEqual({
      allowFrom: ["987654321098765432"],
      dmPolicy: "allowlist",
      enabled: true,
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          channels: {
            "555555555555555555": {
              allow: true
            }
          },
          users: ["987654321098765432"]
        }
      }
    });
    expect(
      result.capabilities.find((capability) => capability.key === "surfaces.discord")?.outcome
    ).toBe("supported");
  });

  it("emits open Discord access without allowlists", async () => {
    const result = await openClawAdapter.compileAgent({
      ...createNode(),
      surfaces: {
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "open",
            users: []
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      }
    });

    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);
    expect(config.channels.discord).toEqual({
      allowFrom: ["*"],
      dmPolicy: "open",
      enabled: true,
      groupPolicy: "open"
    });
  });

  it("emits pairing-only Discord access without guild routing", async () => {
    const result = await openClawAdapter.compileAgent({
      ...createNode(),
      surfaces: {
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "pairing",
            users: []
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      }
    });

    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);
    expect(config.channels.discord).toEqual({
      dmPolicy: "pairing",
      enabled: true
    });
  });

  it("emits Discord DM allowlist access without guild access", async () => {
    const result = await openClawAdapter.compileAgent({
      ...createNode(),
      surfaces: {
        discord: {
          access: {
            channels: [],
            guilds: [],
            mode: "allowlist",
            users: ["987654321098765432"]
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      }
    });

    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);
    expect(config.channels.discord).toEqual({
      allowFrom: ["987654321098765432"],
      dmPolicy: "allowlist",
      enabled: true,
      groupPolicy: "disabled"
    });
  });

  it("emits Discord guild allowlist access without DM allowlist", async () => {
    const result = await openClawAdapter.compileAgent({
      ...createNode(),
      surfaces: {
        discord: {
          access: {
            channels: [],
            guilds: ["123456789012345678"],
            mode: "allowlist",
            users: []
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      }
    });

    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);
    expect(config.channels.discord).toEqual({
      enabled: true,
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {}
      }
    });
  });

  it("emits Telegram channel config when Telegram is declared", async () => {
    const result = await openClawAdapter.compileAgent({
      ...createNode(),
      surfaces: {
        telegram: {
          access: {
            chats: ["-1001234567890"],
            mode: "allowlist",
            users: ["123456789"]
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      }
    });

    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);
    expect(config.channels.telegram).toEqual({
      allowFrom: ["123456789"],
      dmPolicy: "allowlist",
      enabled: true,
      groupPolicy: "allowlist",
      groups: {
        "-1001234567890": {
          allowFrom: ["123456789"]
        }
      }
    });
    expect(
      result.capabilities.find((capability) => capability.key === "surfaces.telegram")?.outcome
    ).toBe("supported");
  });

  it("emits a generated provider catalog entry for custom endpoints", async () => {
    const customResult = await openClawAdapter.compileAgent({
      ...createNode(),
      execution: {
        model: {
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
    const config = JSON.parse(
      customResult.files.find((file) => file.path === "openclaw.json")!.content
    );

    expect(customResult.files.find((file) => file.path === "openclaw.json")).toBeTruthy();
    expect(config.agents.defaults.model).toBe("spawnfile-custom/foo-large");
    expect(config.models.providers["spawnfile-custom"].baseUrl).toBe("https://llm.example.com/v1");
    expect(config.models.providers["spawnfile-custom"].apiKey).toEqual({
      id: "CUSTOM_API_KEY",
      provider: "default",
      source: "env"
    });
    expect(config.models.providers["spawnfile-custom"].api).toBe("anthropic-messages");
  });

  it("emits native Moltnet runtime config from OpenClaw runtime options", async () => {
    const result = await openClawAdapter.compileAgent(
      createNode({
        moltnet: {
          base_url: "http://127.0.0.1:8787/",
          enabled: true,
          network_id: "local_lab",
          timeout_ms: 15000
        }
      })
    );

    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);
    expect(config.moltnet).toEqual({
      baseUrl: "http://127.0.0.1:8787",
      enabled: true,
      networkId: "local_lab",
      timeoutMs: 15000
    });
  });

  it("adds config env bindings for Moltnet token secrets", async () => {
    const runtimeOptions = {
      moltnet: {
        base_url: "http://127.0.0.1:8787",
        token_secret: "MOLTNET_API_TOKEN"
      }
    };
    const inputs = [
      {
        emittedFiles: (await openClawAdapter.compileAgent(createNode(runtimeOptions))).files,
        id: "agent:assistant",
        kind: "agent" as const,
        slug: "assistant",
        value: createNode(runtimeOptions)
      }
    ];

    const [target] = await openClawAdapter.createContainerTargets!(inputs);
    expect(target?.configEnvBindings).toContainEqual({
      envName: "MOLTNET_API_TOKEN",
      jsonPath: "moltnet.token"
    });
  });

  it("enables async hooks for Moltnet-attached agents", async () => {
    const node: ResolvedAgentNode = {
      ...createNode(),
      surfaces: {
        moltnet: [
          {
            memberId: "assistant",
            network: "stage_lights",
            rooms: {
              "green-room": {
                wake: "never" as const
              }
            },
            teamSource: "/tmp/team/Spawnfile"
          }
        ]
      }
    };
    const result = await openClawAdapter.compileAgent(node);

    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);
    expect(config.hooks).toEqual({
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
      enabled: true,
      token: "${OPENCLAW_HOOKS_TOKEN}"
    });

    const [target] = await openClawAdapter.createContainerTargets!([
      {
        emittedFiles: result.files,
        id: "agent:assistant",
        kind: "agent" as const,
        slug: "assistant",
        value: node
      }
    ]);
    expect(target?.configEnvBindings).toContainEqual({
      envName: "OPENCLAW_HOOKS_TOKEN",
      jsonPath: "hooks.token"
    });
  });

  it("validates supported and unsupported model target combinations", () => {
    expect(() =>
      openClawAdapter.assertSupportedModelTarget({
        auth: { method: "claude-code" },
        name: "claude-opus-4-6",
        provider: "anthropic"
      })
    ).not.toThrow();

    expect(() =>
      openClawAdapter.assertSupportedModelTarget({
        auth: { method: "none" },
        name: "qwen2.5:14b",
        provider: "ollama"
      })
    ).not.toThrow();

    expect(() =>
      openClawAdapter.assertSupportedModelTarget({
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
    expect(openClawAdapter.validateRuntimeOptions?.({ profile: 123 })).toEqual([
      {
        level: "error",
        message: "OpenClaw runtime option profile must be a string"
      }
    ]);

    expect(
      openClawAdapter.validateRuntimeOptions?.({
        moltnet: {
          base_url: "ftp://example.com",
          token: "abc",
          token_secret: "MOLTNET_API_TOKEN"
        }
      })
    ).toEqual([
      {
        level: "error",
        message: "OpenClaw runtime option moltnet.base_url must use http or https"
      },
      {
        level: "error",
        message: "OpenClaw runtime option moltnet must not declare both token and token_secret"
      }
    ]);
  });

  it("rejects ambiguous Discord channel allowlists without exactly one guild", () => {
    expect(() =>
      openClawAdapter.assertSupportedSurfaces?.({
        discord: {
          access: {
            channels: ["555555555555555555"],
            guilds: ["123", "456"],
            mode: "allowlist",
            users: []
          },
          botTokenSecret: "DISCORD_BOT_TOKEN"
        }
      })
    ).toThrow(/exactly one guild id/);
  });

  it("accepts Telegram pairing and allowlist access", () => {
    expect(() =>
      openClawAdapter.assertSupportedSurfaces?.({
        telegram: {
          access: {
            chats: [],
            mode: "pairing",
            users: []
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).not.toThrow();

    expect(() =>
      openClawAdapter.assertSupportedSurfaces?.({
        telegram: {
          access: {
            chats: ["-1001234567890"],
            mode: "allowlist",
            users: ["123456789"]
          },
          botTokenSecret: "TELEGRAM_BOT_TOKEN"
        }
      })
    ).not.toThrow();
  });
});
