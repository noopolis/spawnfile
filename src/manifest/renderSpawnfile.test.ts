import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { renderSpawnfile } from "./renderSpawnfile.js";
import { createAgentScaffoldManifest } from "./scaffold.js";
import { manifestSchema } from "./schemas.js";

describe("renderSpawnfile", () => {
  it("renders a valid agent manifest as YAML", () => {
    const source = renderSpawnfile({
      workspace: {
        docs: {
          system: "AGENTS.md"
        }
      },
      expose: true,
      execution: {
        model: {
          auth: {
            method: "api_key"
          },
          primary: {
            name: "claude-sonnet-4-5",
            provider: "anthropic"
          }
        },
        sandbox: {
          mode: "workspace"
        }
      },
      kind: "agent",
      name: "my-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(source).toContain("runtime: openclaw");
    expect(source).toContain("expose: true");
    expect(
      manifestSchema.parse(YAML.parse(source) as unknown)
    ).toMatchObject({
      expose: true,
      kind: "agent",
      runtime: "openclaw"
    });
  });

  it("renders scaffold manifests in canonical top-level order", () => {
    const source = renderSpawnfile(
      createAgentScaffoldManifest({
        docs: {
          identity: "IDENTITY.md",
          soul: "SOUL.md",
          system: "AGENTS.md"
        },
        modelName: "claude-opus-4-6",
        provider: "anthropic",
        runtime: "openclaw"
      })
    );

    const spawnfileVersionIndex = source.indexOf("spawnfile_version:");
    const kindIndex = source.indexOf("kind: agent");
    const nameIndex = source.indexOf("name: my-agent");
    const runtimeIndex = source.indexOf("runtime: openclaw");
    const executionIndex = source.indexOf("execution:");
    const workspaceIndex = source.indexOf("workspace:");

    expect(spawnfileVersionIndex).toBeGreaterThanOrEqual(0);
    expect(kindIndex).toBeGreaterThan(spawnfileVersionIndex);
    expect(nameIndex).toBeGreaterThan(kindIndex);
    expect(runtimeIndex).toBeGreaterThan(nameIndex);
    expect(executionIndex).toBeGreaterThan(runtimeIndex);
    expect(workspaceIndex).toBeGreaterThan(executionIndex);
    expect(source).toContain("      name: claude-opus-4-6");
    expect(source).toContain("      provider: anthropic");
    expect(source).toContain("\nworkspace:");
    expect(source).not.toContain("  sandbox:");
    expect(source).toContain("    identity: IDENTITY.md");
    expect(source).toContain("    soul: SOUL.md");
    expect(source).toContain("    system: AGENTS.md");
    expect(source).toContain('name: my-agent\n\nruntime: openclaw\n\nexecution:');
    expect(source).toContain("      provider: anthropic\n      name: claude-opus-4-6\n\nworkspace:");
  });

  it("renders agent schedules after execution", () => {
    const source = renderSpawnfile({
      workspace: {
        docs: {
          heartbeat: "HEARTBEAT.md",
          system: "AGENTS.md"
        }
      },
      execution: {
        model: {
          primary: {
            name: "gpt-5.5",
            provider: "openai"
          }
        }
      },
      kind: "agent",
      name: "scheduled-agent",
      runtime: "picoclaw",
      schedule: {
        cron: "0 5 * * *",
        kind: "cron",
        prompt: "Perform one bounded iteration.",
        timezone: "UTC"
      },
      spawnfile_version: "0.1"
    });

    const executionIndex = source.indexOf("execution:");
    const scheduleIndex = source.indexOf("schedule:");
    const workspaceIndex = source.indexOf("workspace:");

    expect(scheduleIndex).toBeGreaterThan(executionIndex);
    expect(workspaceIndex).toBeGreaterThan(scheduleIndex);
    expect(source).toContain(
      [
        "schedule:",
        "  kind: cron",
        "  cron: 0 5 * * *",
        "  timezone: UTC",
        "  prompt: Perform one bounded iteration."
      ].join("\n")
    );
    expect(manifestSchema.parse(YAML.parse(source) as unknown)).toMatchObject({
      kind: "agent",
      schedule: {
        cron: "0 5 * * *",
        kind: "cron"
      }
    });
  });

  it("renders workspace resources in canonical order", () => {
    const source = renderSpawnfile({
      kind: "agent",
      name: "resource-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      workspace: {
        docs: {
          system: "AGENTS.md"
        },
        resources: [
          {
            branch: "main",
            id: "project",
            kind: "git",
            mode: "mutable",
            mount: "/work/project",
            url: "https://example.com/project.git"
          },
          {
            id: "cache",
            kind: "volume",
            mode: "readonly",
            mount: "/cache",
            name: "agent-cache",
            sharing: "team"
          }
        ]
      }
    });

    expect(source).toContain(
      [
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "  resources:",
        "    - id: project",
        "      kind: git",
        "      url: https://example.com/project.git",
        "      branch: main",
        "      mount: /work/project",
        "      mode: mutable",
        "    - id: cache",
        "      kind: volume",
        "      mount: /cache",
        "      mode: readonly",
        "      name: agent-cache",
        "      sharing: team"
      ].join("\n")
    );
    expect(manifestSchema.parse(YAML.parse(source) as unknown)).toMatchObject({
      workspace: {
        resources: [
          {
            id: "project",
            kind: "git",
            mount: "/work/project"
          },
          {
            id: "cache",
            kind: "volume",
            mount: "/cache",
            sharing: "team"
          }
        ]
      }
    });
  });

  it("renders agent workspace skills and environment in canonical order", () => {
    const source = renderSpawnfile({
      kind: "agent",
      name: "ops-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      workspace: {
        docs: {
          identity: "IDENTITY.md",
          system: "AGENTS.md"
        },
        skills: [
          {
            ref: "./skills/web_search"
          }
        ]
      },
      environment: {
        env: {
          NODE_ENV: "production"
        },
        packages: [
          {
            id: "gh",
            manager: "apt",
            name: "gh"
          }
        ],
        mcp_servers: [
          {
            command: "uvx",
            name: "memory",
            transport: "stdio"
          }
        ],
        secrets: [
          {
            name: "OPS_TOKEN",
            required: false
          }
        ]
      }
    });

    const workspaceIndex = source.indexOf("workspace:");
    const environmentIndex = source.indexOf("environment:");
    const skillsIndex = source.indexOf("skills:");
    const envIndex = source.indexOf("env:");
    const packagesIndex = source.indexOf("packages:");
    const mcpIndex = source.indexOf("mcp_servers:");

    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(skillsIndex).toBeGreaterThan(workspaceIndex);
    expect(environmentIndex).toBeGreaterThan(workspaceIndex);
    expect(envIndex).toBeGreaterThan(environmentIndex);
    expect(packagesIndex).toBeGreaterThan(envIndex);
    expect(mcpIndex).toBeGreaterThan(packagesIndex);
    expect(source).toContain("workspace:");
    expect(source).toContain("  skills:");
    expect(source).toContain("environment:");
    expect(source).toContain("  env:");
    expect(source).toContain("    NODE_ENV: production");
    expect(source).toContain("    - id: gh");
    expect(source).toContain("    - command: uvx");
    expect(manifestSchema.parse(YAML.parse(source) as unknown)).toMatchObject({
      environment: {
        packages: [
          {
            id: "gh",
            manager: "apt",
            name: "gh"
          }
        ]
      }
    });
  });

  it("renders managed moltnet server settings on team manifests", () => {
    const source = renderSpawnfile({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "research-team",
      networks: [
        {
          id: "local_lab",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              mode: "open"
            },
            listen: {
              bind: "127.0.0.1",
              port: 8787
            },
            store: {
              kind: "sqlite",
              path: "/tmp/local-lab.sqlite"
            },
            direct_messages: true
          },
          rooms: [
            {
              id: "research",
              members: ["analyst"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(source).toContain("    server:");
    expect(source).toContain("      mode: managed");
    expect(source).toContain("      direct_messages: true");
    expect(source).toContain("      port: 8787");
    expect(source).toContain("      auth:");
    expect(source).toContain("      store:");
    expect(manifestSchema.parse(YAML.parse(source) as unknown)).toMatchObject({
      kind: "team",
      networks: [
        {
          id: "local_lab",
          server: {
            mode: "managed",
            auth: {
              mode: "open"
            },
            listen: {
              bind: "127.0.0.1",
              port: 8787
            },
            store: {
              kind: "sqlite",
              path: "/tmp/local-lab.sqlite"
            },
            direct_messages: true
          }
        }
      ]
    });
  });

  it("renders shared workspace and environment in canonical order", () => {
    const source = renderSpawnfile({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "ops-team",
      shared: {
        workspace: {
          docs: {
            system: "TEAM.md"
          },
          skills: [
            {
              ref: "./skills/web_search"
            }
          ]
        },
        environment: {
          env: {
            TEAM_MODE: "team"
          },
          packages: [
            {
              id: "yt-dlp",
              manager: "pipx",
              name: "yt-dlp"
            }
          ]
        }
      },
      spawnfile_version: "0.1"
    });

    const sharedIndex = source.indexOf("shared:");
    const workspaceIndex = source.indexOf("  workspace:");
    const environmentIndex = source.indexOf("  environment:");
    const skillsIndex = source.indexOf("  skills:");

    expect(sharedIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceIndex).toBeGreaterThan(sharedIndex);
    expect(skillsIndex).toBeGreaterThan(workspaceIndex);
    expect(environmentIndex).toBeGreaterThan(skillsIndex);
    expect(source).toContain("shared:");
    expect(source).toContain("  workspace:");
    expect(source).toContain("    docs:");
    expect(source).toContain("    skills:");
    expect(source).toContain("  environment:");
    expect(source).toContain("    env:");
  });

  it("redacts moltnet secret values when rendering", () => {
    const source = renderSpawnfile({
      kind: "team",
      lead: "operator",
      members: [
        {
          id: "operator",
          ref: "./agents/operator"
        }
      ],
      mode: "swarm",
      name: "secure-team",
      networks: [
        {
          id: "local_lab",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              client: {
                token_id: "operator",
                static_token: true
              },
              mode: "bearer",
              tokens: [
                {
                  id: "operator",
                  secret: "MOLTNET_OPERATOR_TOKEN",
                  scopes: ["attach", "write"]
                }
              ]
            },
            listen: {
              bind: "127.0.0.1",
              port: 8787
            },
            store: {
              kind: "sqlite",
              path: "/tmp/local-lab.sqlite"
            },
            pairings: [
              {
                id: "pairing_one",
                remote_base_url: "https://partner-net.example",
                remote_network_id: "partner_net",
                remote_network_name: "PartnerNet",
                token_secret: "MOLTNET_PAIRING_TOKEN"
              }
            ],
          },
          rooms: [
            {
              id: "research",
              members: ["operator"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(source).not.toContain("MOLTNET_OPERATOR_TOKEN");
    expect(source).not.toContain("MOLTNET_PAIRING_TOKEN");
    expect(source).toContain("id: operator");
    expect(source).toContain("mode: bearer");
  });

  it("renders rewritten agent manifests with subagents in canonical order", () => {
    const source = renderSpawnfile({
      workspace: {
        docs: {
          identity: "IDENTITY.md",
          soul: "SOUL.md",
          system: "AGENTS.md"
        }
      },
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      name: "my-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      subagents: [
        {
          id: "pepito",
          ref: "./subagents/pepito"
        }
      ]
    });

    const spawnfileVersionIndex = source.indexOf("spawnfile_version:");
    const kindIndex = source.indexOf("kind: agent");
    const nameIndex = source.indexOf("name: my-agent");
    const runtimeIndex = source.indexOf("runtime: openclaw");
    const executionIndex = source.indexOf("execution:");
    const workspaceIndex = source.indexOf("workspace:");
    const subagentsIndex = source.indexOf("subagents:");

    expect(spawnfileVersionIndex).toBeGreaterThanOrEqual(0);
    expect(kindIndex).toBeGreaterThan(spawnfileVersionIndex);
    expect(nameIndex).toBeGreaterThan(kindIndex);
    expect(runtimeIndex).toBeGreaterThan(nameIndex);
    expect(executionIndex).toBeGreaterThan(runtimeIndex);
    expect(workspaceIndex).toBeGreaterThan(executionIndex);
    expect(subagentsIndex).toBeGreaterThan(workspaceIndex);
    expect(source).toContain("name: my-agent\n\nruntime: openclaw\n\nexecution:");
    expect(source).toContain("workspace:\n  docs:\n    identity: IDENTITY.md");
    expect(source).toContain("system: AGENTS.md\n\nsubagents:");
  });

  it("renders surfaces after docs in canonical order", () => {
    const source = renderSpawnfile({
      workspace: {
        docs: {
          system: "AGENTS.md"
        }
      },
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      name: "discord-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            mode: "allowlist",
            users: ["987654321098765432"],
            guilds: ["123456789012345678"],
            channels: ["555555555555555555"]
          },
          bot_token_secret: "TEAM_DISCORD_TOKEN"
        }
      }
    });

    const workspaceIndex = source.indexOf("workspace:");
    const surfacesIndex = source.indexOf("surfaces:");

    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(surfacesIndex).toBeGreaterThan(workspaceIndex);
    expect(source).toContain(
      [
        "surfaces:",
        "  discord:",
        "    access:",
        "      mode: allowlist",
        "      users:",
        "        - \"987654321098765432\"",
        "      guilds:",
        "        - \"123456789012345678\"",
        "      channels:",
        "        - \"555555555555555555\"",
        "    bot_token_secret: TEAM_DISCORD_TOKEN"
      ].join("\n")
    );
  });

  it("renders telegram surfaces after discord in canonical order", () => {
    const source = renderSpawnfile({
      workspace: {
        docs: {
          system: "AGENTS.md"
        }
      },
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "agent",
      name: "telegram-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {},
        telegram: {
          access: {
            mode: "allowlist",
            users: ["123456789"],
            chats: ["-1001234567890"]
          },
          bot_token_secret: "TEAM_TELEGRAM_TOKEN"
        }
      }
    });

    expect(source).toContain(
      [
        "surfaces:",
        "  discord: {}",
        "  telegram:",
        "    access:",
        "      mode: allowlist",
        "      users:",
        "        - \"123456789\"",
        "      chats:",
        "        - \"-1001234567890\"",
        "    bot_token_secret: TEAM_TELEGRAM_TOKEN"
      ].join("\n")
    );
  });

  it("renders whatsapp before slack in canonical order", () => {
    const source = renderSpawnfile({
      kind: "agent",
      name: "multi-surface-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        slack: {
          access: {
            mode: "allowlist",
            users: ["U1234567890"],
            channels: ["C1234567890"]
          },
          bot_token_secret: "TEAM_SLACK_BOT_TOKEN",
          app_token_secret: "TEAM_SLACK_APP_TOKEN"
        },
        whatsapp: {
          access: {
            mode: "allowlist",
            users: ["15551234567"],
            groups: ["120363400000000000@g.us"]
          }
        }
      }
    });

    expect(source).toContain(
      [
        "surfaces:",
        "  whatsapp:",
        "    access:",
        "      mode: allowlist",
        "      users:",
        "        - \"15551234567\"",
        "      groups:",
        "        - 120363400000000000@g.us",
        "  slack:",
        "    access:",
        "      mode: allowlist",
        "      users:",
        "        - U1234567890",
        "      channels:",
        "        - C1234567890",
        "    bot_token_secret: TEAM_SLACK_BOT_TOKEN",
        "    app_token_secret: TEAM_SLACK_APP_TOKEN"
      ].join("\n")
    );
  });

  it("round-trips surface identities", () => {
    const source = renderSpawnfile({
      kind: "agent",
      name: "identity-agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          identity: { user_id: "987654321098765432" }
        },
        slack: {
          identity: { user_id: "U1234567890" }
        },
        telegram: {
          identity: { user_id: "123456789", username: "identity_agent" }
        },
        whatsapp: {
          identity: { phone: "+15551234567" }
        }
      }
    });

    const parsed = manifestSchema.parse(YAML.parse(source) as unknown);

    expect(source).toContain("    identity:");
    expect(parsed).toMatchObject({
      surfaces: {
        discord: { identity: { user_id: "987654321098765432" } },
        slack: { identity: { user_id: "U1234567890" } },
        telegram: { identity: { user_id: "123456789", username: "identity_agent" } },
        whatsapp: { identity: { phone: "+15551234567" } }
      }
    });
  });

  it("renders inline model auth and endpoint fields in canonical order", () => {
    const source = renderSpawnfile({
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
      },
      kind: "agent",
      name: "custom-agent",
      runtime: "picoclaw",
      spawnfile_version: "0.1"
    });

    expect(source).toContain(
      [
        "    primary:",
        "      provider: custom",
        "      name: foo-large",
        "      auth:",
        "        method: api_key",
        "        key: CUSTOM_API_KEY",
        "      endpoint:",
        "        base_url: https://llm.example.com/v1",
        "        compatibility: anthropic"
      ].join("\n")
    );
    expect(source).toContain(
      [
        "    fallback:",
        "      - provider: local",
        "        name: qwen2.5:14b",
        "        auth:",
        "          method: none",
        "        endpoint:",
        "          base_url: http://host.docker.internal:11434/v1",
        "          compatibility: openai"
      ].join("\n")
    );
  });

  it("renders moltnet surfaces and team networks in canonical order", () => {
    const agentSource = renderSpawnfile({
      kind: "agent",
      name: "researcher",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        moltnet: [
          {
            network: "local_lab",
            rooms: {
              research: {
                read: "mentions",
                reply: "auto"
              }
            },
            dms: {
              enabled: true,
              read: "all",
              reply: "never"
            }
          }
        ]
      }
    });

    const teamSource = renderSpawnfile({
      kind: "team",
      lead: "researcher",
      members: [
        {
          id: "researcher",
          ref: "./agents/researcher"
        }
      ],
      mode: "hierarchical",
      name: "research-cell",
      networks: [
        {
          id: "local_lab",
          provider: "moltnet",
          server: {
            auth: {
              mode: "open"
            },
            listen: {
              bind: "127.0.0.1",
              port: 8787
            },
            mode: "managed",
            store: {
              kind: "sqlite",
              path: "/tmp/local_lab.sqlite"
            }
          },
          rooms: [
            {
              id: "research",
              members: ["researcher"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(agentSource).toContain("  moltnet:");
    expect(agentSource).toContain("    - network: local_lab");
    expect(agentSource).toContain("      rooms:");
    expect(agentSource).toContain("        research:");
    expect(agentSource).toContain("          read: mentions");
    expect(agentSource).toContain("          reply: auto");
    expect(agentSource).toContain("        enabled: true");
    expect(teamSource).toContain("networks:");
    expect(teamSource).toContain("  - id: local_lab");
    expect(teamSource).toContain("    provider: moltnet");
    expect(teamSource).toContain("      - id: research");
  });
});
