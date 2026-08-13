import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";

import { piAdapter } from "./adapter.js";
import {
  createPiAgentConfig,
  PI_HARNESS_SYSTEM_PROMPT,
  renderPiModelsConfig,
  resolvePiThinkingFormat
} from "./appTemplate.js";

const createNode = (
  overrides: Partial<ResolvedAgentNode> = {}
): ResolvedAgentNode => ({
  description: "Pi test agent",
  docs: [
    {
      content: "# Instructions\n",
      role: "system",
      sourcePath: "/tmp/AGENTS.md"
    }
  ],
  env: {},
  execution: {
    model: {
      primary: {
        auth: { method: "codex" },
        name: "gpt-5.4-mini",
        provider: "openai"
      }
    },
    sandbox: { mode: "workspace" }
  },
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "pi", options: {} },
  secrets: [],
  skills: [
    {
      content: "---\nname: note\ndescription: Note\n---\n\nCreate notes.\n",
      name: "note",
      ref: "./skills/note",
      requiresMcp: [],
      sourcePath: "/tmp/skills/note/SKILL.md"
    }
  ],
  source: "/tmp/agent/Spawnfile",
  subagents: [],
  ...overrides
});

describe("piAdapter capabilities", () => {
  it("lowers an explicit Pi thinking level", () => {
    const config = createPiAgentConfig(
      createNode({
        runtime: {
          name: "pi",
          options: { thinking: "minimal", tools: [] }
        }
      }),
      "assistant",
      "agent:assistant"
    );
    expect(config.thinking_level).toBe("minimal");
    expect(config.tools).toEqual([]);
    expect(piAdapter.validateRuntimeOptions?.({
      thinking_format: "unsupported"
    })).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("thinking_format")
      })
    ]);
  });

  it("lowers explicit bounded raw-training capture and leaves it absent by default", () => {
    expect(
      createPiAgentConfig(createNode(), "assistant", "agent:assistant")
        .raw_training_capture
    ).toBeUndefined();

    const config = createPiAgentConfig(
      createNode({
        runtime: {
          name: "pi",
          options: { raw_training_capture_turns: 250 }
        }
      }),
      "assistant",
      "agent:assistant"
    );
    expect(config.raw_training_capture).toEqual({
      enabled: true,
      retention: { maxTurns: 250 }
    });
    expect(piAdapter.validateRuntimeOptions?.({
      raw_training_capture_turns: 0
    })).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("between 1 and 100000")
      })
    ]);
  });

  it("maps generated app model and schedule config paths", () => {
    expect(createPiAgentConfig(createNode({ execution: undefined }), "assistant", "agent:assistant").model).toEqual({
      auth_method: "codex",
      name: "gpt-5.4-mini",
      provider: "openai-codex"
    });

    expect(
      createPiAgentConfig(
        createNode({
          execution: {
            model: {
              primary: {
                auth: { method: "api_key" },
                name: "claude-sonnet-4-5",
                provider: "anthropic"
              }
            },
            sandbox: { mode: "workspace" }
          },
          schedule: { cron: "* * * * *", kind: "cron" }
        }),
        "assistant",
        "agent:assistant"
      ).schedule
    ).toBeUndefined();

    expect(
      createPiAgentConfig(createNode({ schedule: { kind: "disabled" } }), "assistant", "agent:assistant").schedule
    ).toEqual({ kind: "disabled" });

    expect(
      createPiAgentConfig(
        createNode({
          execution: {
            model: {
              primary: {
                auth: { method: "none" },
                endpoint: {
                  base_url: "http://127.0.0.1:8080/v1",
                  compatibility: "openai"
                },
                name: "local-model",
                provider: "local"
              }
            },
            sandbox: { mode: "workspace" }
          }
        }),
        "assistant",
        "agent:assistant"
      ).model
    ).toEqual({
      auth_method: "none",
      name: "local-model",
      provider: expect.stringMatching(/^local-openai-local-model-[a-f0-9]{8}$/)
    });
  });

  it("embeds the Spawnfile Pi harness contract into generated agent instructions", async () => {
    const mapper = createNode({ name: "mapper", source: "/tmp/mapper/Spawnfile" });
    const mapperCompiled = await piAdapter.compileAgent(mapper);
    const targets = await piAdapter.createContainerTargets?.([
      {
        emittedFiles: mapperCompiled.files,
        id: "agent:mapper",
        kind: "agent",
        slug: "mapper",
        value: mapper
      }
    ]);

    const config = JSON.parse(targets?.[0]?.files.find((file) => file.path === "pi-app.json")?.content ?? "{}");
    const instructions = config.agents[0]?.instructions as string;

    expect(instructions).toContain(PI_HARNESS_SYSTEM_PROMPT);
    expect(instructions).toContain("Moltnet messages are coordination events");
    expect(instructions).toContain("You do not need to reply to every Moltnet message");
    expect(instructions).toContain("Do not claim that a file edit, command, or commit happened unless you verified it");
  });

	  it("serializes direct Mneme memory config for Pi engine agents", () => {
    const config = createPiAgentConfig(
      createNode({
        memoryAccess: [
          {
            agentSource: "/tmp/agent/Spawnfile",
            bank: {
              consolidation: { mode: "disabled" },
              declaredBy: "team",
              declaredName: "research",
              id: "shared",
              index: {
                graph: { enabled: false },
                lexical: { enabled: true },
                rerank: { enabled: false },
                vector: {
                  base_url: "http://127.0.0.1:11435",
                  dimensions: 1024,
                  enabled: true,
                  model: "qwen3-embedding:0.6b",
                  provider: "ollama",
                  timeout_ms: 2500
                }
              },
              retention: { forgetting: "manual" },
              source: "/tmp/team/Spawnfile",
              store: {
                kind: "sqlite",
                path: "/var/lib/spawnfile/memory/research/shared/memory.sqlite",
                persistence: { mode: "durable" }
              }
            },
            declaringKind: "team",
            slotId: "assistant",
            source: "/tmp/team/Spawnfile"
          }
        ]
      }),
      "assistant",
      "agent:assistant"
    );

	    expect(config.memory).toEqual({
	      bank_id: "shared",
      embedding: {
        base_url: "http://127.0.0.1:11435",
        dimensions: 1024,
        model: "qwen3-embedding:0.6b",
        provider: "ollama",
        timeout_ms: 2500
      },
      runtime_home_path: "/var/lib/spawnfile/memory/research/shared",
	      source: "spawnfile:team:shared"
	    });
	  });

	  it("serializes scheduled Mneme consolidation as Pi dream wake config", () => {
	    const config = createPiAgentConfig(
	      createNode({
	        memoryAccess: [
	          {
	            agentSource: "/tmp/agent/Spawnfile",
	            bank: {
	              consolidation: { mode: "scheduled", schedule: "6h" },
	              declaredBy: "team",
	              declaredName: "research",
	              id: "shared",
	              index: {
	                graph: { enabled: false },
	                lexical: { enabled: true },
	                rerank: { enabled: false },
	                vector: { enabled: false }
	              },
	              retention: { forgetting: "manual" },
	              source: "/tmp/team/Spawnfile",
	              store: {
	                kind: "sqlite",
	                path: "/var/lib/spawnfile/memory/research/shared/memory.sqlite",
	                persistence: { mode: "durable" }
	              }
	            },
	            declaringKind: "team",
	            slotId: "assistant",
	            source: "/tmp/team/Spawnfile"
	          }
	        ]
	      }),
	      "assistant",
	      "agent:assistant"
	    );

	    expect(config.memory?.consolidation).toEqual({
	      every: "6h",
	      kind: "every",
	      prompt: expect.stringContaining("Dream over Mneme memory bank shared.")
	    });
	  });

  it("serializes Mneme memory config for CLI-backed engines", async () => {
    const node = createNode({
      memoryAccess: [
        {
          agentSource: "/tmp/agent/Spawnfile",
          bank: {
            consolidation: { mode: "disabled" },
            declaredBy: "agent",
            declaredName: "assistant",
            id: "private",
            index: {
              graph: { enabled: false },
              lexical: { enabled: true },
              rerank: { enabled: false },
              vector: { enabled: false }
            },
            retention: { forgetting: "manual" },
            source: "/tmp/agent/Spawnfile",
            store: {
              kind: "sqlite",
              path: "/var/lib/spawnfile/memory/assistant/private/memory.sqlite",
              persistence: { mode: "durable" }
            }
          },
          declaringKind: "agent",
          source: "/tmp/agent/Spawnfile"
        }
      ],
      runtime: { name: "pi", options: { engine: "codex" } }
    });

    expect(createPiAgentConfig(node, "assistant", "agent:assistant").memory).toEqual({
      bank_id: "private",
      runtime_home_path: "/var/lib/spawnfile/memory/assistant/private",
      source: "spawnfile:agent:private"
    });
    const compiled = await piAdapter.compileAgent(node);
    expect(compiled.capabilities).toContainEqual({
      key: "memory.private",
      message: "Daimon exposes Mneme memory through generated runtime turns",
      outcome: "supported"
    });
  });

  it("reports MCP and parent-owned subagent semantics as degraded", async () => {
    const compiled = await piAdapter.compileAgent(createNode({
      mcpServers: [
        {
          command: "node",
          name: "search",
          transport: "stdio"
        }
      ],
      subagents: [
        {
          id: "critic",
          nodeSource: "/tmp/critic/Spawnfile"
        }
      ]
    }));

    expect(compiled.capabilities).toContainEqual({
      key: "mcp.search",
      message: "",
      outcome: "degraded"
    });
    expect(compiled.capabilities).toContainEqual({
      key: "agent.subagents",
      message: "",
      outcome: "degraded"
    });
    expect(compiled.diagnostics).toContainEqual({
      level: "warn",
      message: "Pi runtime does not lower MCP server declarations in Spawnfile v0.1"
    });
    expect(compiled.diagnostics).toContainEqual({
      level: "warn",
      message: "Pi runtime groups compiled agents but does not preserve native parent-owned subagent semantics in v0.1"
    });
  });

  it("fails closed for every invalid generated Pi runtime option", () => {
    for (const options of [
      { engine: "invalid" },
      { thinking: "extreme" },
      { tools: ["read", "read"] },
      { raw_training_capture_turns: 100_001 }
    ]) {
      expect(() => createPiAgentConfig(
        createNode({ runtime: { name: "pi", options } }),
        "assistant",
        "agent:assistant"
      )).toThrow(/Pi runtime option/);
    }
    expect(() => resolvePiThinkingFormat(
      createNode({ runtime: { name: "pi", options: { thinking_format: "invalid" } } })
    )).toThrow(/Pi runtime option thinking_format/);
  });

  it("renders Anthropic endpoint auth and uncommon memory-store branches", () => {
    const endpointNode = createNode({
      execution: {
        model: {
          primary: {
            auth: { key: "ANTHROPIC_API_KEY", method: "api_key" },
            endpoint: {
              base_url: "https://models.example/v1",
              compatibility: "anthropic"
            },
            name: "claude-test",
            provider: "local"
          }
        },
        sandbox: { mode: "workspace" }
      }
    });
    const models = JSON.parse(renderPiModelsConfig([endpointNode])) as {
      providers: Record<string, { api: string; apiKey: string }>;
    };
    expect(Object.values(models.providers)).toEqual([
      expect.objectContaining({ api: "anthropic-messages", apiKey: "$ANTHROPIC_API_KEY" })
    ]);

    const access = {
      agentSource: "/tmp/agent/Spawnfile",
      bank: {
        consolidation: { mode: "scheduled", schedule: "not-an-interval" },
        declaredBy: "agent",
        declaredName: "volatile",
        id: "volatile",
        index: {
          graph: { enabled: false },
          lexical: { enabled: true },
          rerank: { enabled: false },
          vector: { enabled: false }
        },
        retention: { forgetting: "manual" },
        source: "/tmp/agent/Spawnfile",
        store: { kind: "memory" }
      },
      declaringKind: "agent",
      source: "/tmp/agent/Spawnfile"
    } as NonNullable<ResolvedAgentNode["memoryAccess"]>[number];
    expect(createPiAgentConfig(
      createNode({ memoryAccess: [access], schedule: { every: "15m", kind: "every" } }),
      "assistant",
      "agent:assistant"
    )).toMatchObject({
      memory: {
        bank_id: "volatile",
        runtime_home_path: expect.stringContaining("/volatile/")
      },
      schedule: { every: "15m", kind: "every" }
    });
    expect(createPiAgentConfig(
      createNode({
        memoryAccess: [{
          ...access,
          bank: { ...access.bank, store: { dsn_secret: "PG_DSN", kind: "postgres" } }
        }]
      }),
      "assistant",
      "agent:assistant"
    ).memory).toBeUndefined();
  });

  it("accepts Moltnet surfaces and rejects non-Moltnet communication surfaces", () => {
    expect(() => piAdapter.assertSupportedSurfaces?.(undefined)).not.toThrow();

    expect(() =>
      piAdapter.assertSupportedSurfaces?.({
        moltnet: [
          {
            dms: { enabled: false, wake: "never" },
            memberId: "assistant",
            network: "local_lab",
            rooms: {
              agora: { wake: "mentions" }
            },
            teamSource: "/tmp/Spawnfile"
          }
        ]
      })
    ).not.toThrow();

    expect(() =>
      piAdapter.assertSupportedSurfaces?.({
        discord: { botTokenSecret: "DISCORD_BOT_TOKEN" },
        http: { pathPrefix: "/api" },
        slack: {
          appTokenSecret: "SLACK_APP_TOKEN",
          botTokenSecret: "SLACK_BOT_TOKEN"
        },
        telegram: { botTokenSecret: "TELEGRAM_BOT_TOKEN" },
        whatsapp: {}
      })
    ).toThrow(/unsupported surfaces: discord, http, slack, telegram, whatsapp/);

    expect(() =>
      piAdapter.assertSupportedSurfaces?.({
        webhook: {
          url: "https://hooks.example.com/pi"
        }
      })
    ).toThrow(/unsupported surfaces: webhook/);
  });
});
