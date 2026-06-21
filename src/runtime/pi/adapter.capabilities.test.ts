import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";

import { piAdapter } from "./adapter.js";
import { createPiAgentConfig, PI_HARNESS_SYSTEM_PROMPT } from "./appTemplate.js";

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
  it("maps generated app model and schedule config paths", () => {
    expect(createPiAgentConfig(createNode({ execution: undefined }), "assistant", "agent:assistant").model).toEqual({
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
