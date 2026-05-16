import { describe, expect, it } from "vitest";

import { isAgentManifest, isTeamManifest, manifestSchema } from "./schemas.js";

const issueHasPath = (
  result: ReturnType<typeof manifestSchema.safeParse>,
  expectedPath: string
): boolean =>
  result.error?.issues.some((issue) => issue.path.join(".") === expectedPath) ?? false;

const createTeamWithNetwork = (
  server: Record<string, unknown>
): Record<string, unknown> => ({
  kind: "team",
  members: [
    {
      id: "worker",
      ref: "./agents/worker"
    }
  ],
  mode: "swarm",
  name: "worker-cell",
  networks: [
    {
      id: "team_net",
      provider: "moltnet",
      rooms: [
        {
          id: "workroom",
          members: ["worker"]
        }
      ],
      server
    }
  ],
  spawnfile_version: "0.1"
});

const createManagedServer = (
  overrides: Record<string, unknown>
): Record<string, unknown> => ({
  auth: { mode: "none" },
  listen: { bind: "127.0.0.1", port: 8787 },
  mode: "managed",
  store: { kind: "memory" },
  ...overrides
});

describe("manifestSchema", () => {
  it("accepts stdio MCP servers with a command", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      environment: {
        mcp_servers: [
          {
            command: "uvx",
            name: "memory",
            transport: "stdio"
          }
        ]
      },
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects stdio MCP servers without a command", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      environment: {
        mcp_servers: [
          {
            name: "memory",
            transport: "stdio"
          }
        ]
      },
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare command");
  });

  it("rejects remote MCP servers without a url", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      environment: {
        mcp_servers: [
          {
            name: "search",
            transport: "sse"
          }
        ]
      },
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare url");
  });

  it("accepts package declarations with valid managers", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      environment: {
        packages: [
          {
            id: "gh",
            manager: "apt",
            name: "gh"
          },
          {
            id: "code",
            manager: "pipx",
            name: "pytool",
            version: "1.2.3"
          },
          {
            id: "npm-cli",
            manager: "npm",
            name: "@openai/codex",
            scope: "global"
          }
        ]
      },
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects package entries with unsupported scope usage", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      environment: {
        packages: [
          {
            id: "gh",
            manager: "apt",
            name: "gh",
            scope: "global"
          }
        ]
      },
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("scope");
  });

  it("rejects package entries with unknown manager", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      environment: {
        packages: [
          {
            id: "strange",
            manager: "yum",
            name: "yum-pkg"
          }
        ]
      } as never,
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate package ids in one environment scope", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      environment: {
        packages: [
          {
            id: "cli",
            manager: "apt",
            name: "gh"
          },
          {
            id: "cli",
            manager: "npm",
            name: "@openai/codex"
          }
        ]
      },
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("package ids");
  });

  describe("legacy root-level fields", () => {
    const legacyRootFields = [
      ["env", { LEGACY: "true" }],
      ["mcp_servers", [{ name: "search", transport: "sse", url: "https://search.example" }]],
      ["packages", [{ id: "gh", manager: "apt", name: "gh" }]],
      ["secrets", [{ name: "LEGACY", required: true }]],
      ["skills", [{ ref: "./skills/web_search" }]]
    ] as const;

    for (const [field, value] of legacyRootFields) {
      it(`rejects root-level ${field} in agent manifests`, () => {
        const result = manifestSchema.safeParse({
          [field]: value,
          kind: "agent",
          name: "legacy-agent",
          runtime: "openclaw",
          spawnfile_version: "0.1"
        } as never);

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
      });

      it(`rejects root-level ${field} in team manifests`, () => {
        const result = manifestSchema.safeParse({
          [field]: value,
          kind: "team",
          members: [
            {
              id: "analyst",
              ref: "./agents/analyst"
            }
          ],
          mode: "swarm",
          name: "legacy-team",
          spawnfile_version: "0.1"
        } as never);

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
      });
    }
  });

  it("rejects runtime in team manifests", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "runtime-team",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("rejects old shared.skills in team manifests", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "legacy-team",
      shared: {
        skills: [
          {
            ref: "./skills/web_search"
          }
        ]
      },
      spawnfile_version: "0.1"
    } as never);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("rejects old shared.env in team manifests", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "legacy-team",
      shared: {
        env: {
          TEAM: "1"
        }
      },
      spawnfile_version: "0.1"
    } as never);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("rejects old shared.secrets in team manifests", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "legacy-team",
      shared: {
        secrets: [{ name: "LEGACY", required: true }]
      },
      spawnfile_version: "0.1"
    } as never);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("rejects old shared.mcp_servers in team manifests", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "legacy-team",
      shared: {
        mcp_servers: [
          {
            name: "search",
            transport: "sse",
            url: "https://search.example"
          }
        ]
      },
      spawnfile_version: "0.1"
    } as never);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("accepts team workspace skills and shared environment packages", () => {
    const result = manifestSchema.parse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "modern-team",
      shared: {
        workspace: {
          skills: [
            {
              ref: "./skills/web_search"
            }
          ]
        },
        environment: {
          packages: [
            {
              id: "gh",
              manager: "apt",
              name: "gh"
            }
          ]
        }
      },
      spawnfile_version: "0.1"
    });

    expect(isTeamManifest(result)).toBe(true);
    if (!isTeamManifest(result)) {
      throw new Error("expected team manifest");
    }
    expect(result.shared?.environment?.packages?.[0].id).toBe("gh");
  });

  it("accepts agent workspace skills and environment packages", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "worker",
      runtime: "openclaw",
      workspace: {
        docs: {
          system: "AGENTS.md"
        },
        skills: [{ ref: "./skills/web_search" }]
      },
      environment: {
        packages: [
          {
            id: "yt-dlp",
            manager: "pipx",
            name: "yt-dlp",
            version: "2025.1.0"
          }
        ]
      },
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
    if (!isAgentManifest(result)) {
      throw new Error("expected agent manifest");
    }
    expect(result.environment?.packages?.[0].manager).toBe("pipx");
    expect(result.workspace?.skills?.[0].ref).toBe("./skills/web_search");
  });

  it("identifies team manifests", () => {
    const result = manifestSchema.parse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "research-team",
      spawnfile_version: "0.1"
    });

    expect(isTeamManifest(result)).toBe(true);
  });

  it("rejects team auth", () => {
    const result = manifestSchema.safeParse({
      auth: {
        mode: "shared_secret",
        secret: "TEAM_SECRET"
      },
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "research-team",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("accepts expose on agent manifests", () => {
    const result = manifestSchema.parse({
      expose: true,
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
    if (!isAgentManifest(result)) {
      throw new Error("expected agent manifest");
    }
    expect(result.expose).toBe(true);
  });

  it("accepts agent-owned cron schedules", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      schedule: {
        cron: "0 5 * * *",
        kind: "cron",
        prompt: "Wake, read context, and perform one bounded iteration.",
        timezone: "UTC"
      },
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
    if (!isAgentManifest(result)) {
      throw new Error("expected agent manifest");
    }
    expect(result.schedule).toEqual({
      cron: "0 5 * * *",
      kind: "cron",
      prompt: "Wake, read context, and perform one bounded iteration.",
      timezone: "UTC"
    });
  });

  it("accepts agent-owned interval and disabled schedules", () => {
    expect(
      manifestSchema.safeParse({
        kind: "agent",
        name: "agent",
        runtime: "openclaw",
        schedule: {
          every: "2h",
          kind: "every"
        },
        spawnfile_version: "0.1"
      }).success
    ).toBe(true);

    expect(
      manifestSchema.safeParse({
        kind: "agent",
        name: "agent",
        runtime: "openclaw",
        schedule: {
          kind: "disabled"
        },
        spawnfile_version: "0.1"
      }).success
    ).toBe(true);
  });

  it("rejects malformed agent schedules", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      schedule: {
        every: "24h",
        kind: "cron"
      },
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
  });

  it("rejects schedules on team manifests", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "research-team",
      schedule: {
        cron: "0 5 * * *",
        kind: "cron"
      },
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("accepts team networks and agent moltnet surfaces", () => {
    const team = manifestSchema.parse({
      kind: "team",
      members: [
        {
          id: "orchestrator",
          ref: "./agents/orchestrator"
        },
        {
          id: "researcher",
          ref: "./agents/researcher"
        }
      ],
      mode: "hierarchical",
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
            debug_events: true,
            human_ingress: true
          },
          rooms: [
            {
              id: "research",
              members: ["orchestrator", "researcher"]
            }
          ]
        }
      ],
      lead: "orchestrator",
      spawnfile_version: "0.1"
    });
    const agent = manifestSchema.parse({
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
            }
          }
        ]
      }
    });

    expect(isTeamManifest(team)).toBe(true);
    expect(isAgentManifest(agent)).toBe(true);
    if (!isTeamManifest(team)) {
      throw new Error("expected team manifest");
    }
    const server = team.networks?.[0]?.server;
    expect(server?.mode).toBe("managed");
    if (server?.mode !== "managed") {
      throw new Error("expected managed server");
    }
    expect(server.listen).toEqual({ bind: "127.0.0.1", port: 8787 });
    expect(server.debug_events).toBe(true);
    expect(server.human_ingress).toBe(true);
  });

  it("accepts managed moltnet server mode with required network fields", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              mode: "bearer",
              client: {
                token_id: "attachments"
              },
              tokens: [
                {
                  id: "attachments",
                  secret: "MOLTNET_ATTACH_TOKEN",
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
              path: "/var/lib/moltnet/team_net.sqlite"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("accepts managed Moltnet file store persistence declarations", () => {
    const result = manifestSchema.safeParse(createTeamWithNetwork(createManagedServer({
      store: {
        kind: "sqlite",
        persistence: {
          mode: "durable",
          mount: "/var/lib/spawnfile/moltnet/networks/team_net",
          name: "team-net-state"
        }
      }
    })));

    expect(result.success).toBe(true);
  });

  it("rejects invalid managed Moltnet file store persistence declarations", () => {
    const cases = [
      {
        kind: "sqlite",
        path: "relative.db"
      },
      {
        kind: "sqlite",
        path: "/var/lib/moltnet/team_net.sqlite",
        persistence: {
          mode: "durable",
          mount: "/data/moltnet"
        }
      },
      {
        kind: "json",
        persistence: {
          mode: "ephemeral",
          name: "should-not-exist"
        }
      }
    ];

    for (const store of cases) {
      const result = manifestSchema.safeParse(createTeamWithNetwork(createManagedServer({ store })));
      expect(result.success).toBe(false);
    }
  });

  it("rejects managed moltnet servers that omit listen", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              mode: "open"
            },
            store: {
              kind: "sqlite",
              path: "/var/lib/moltnet/team_net.sqlite"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(
      issueHasPath(result, "networks.0.server.listen") ||
        issueHasPath(result, "networks.0.server")
    ).toBe(true);
  });

  it("rejects managed moltnet servers that omit a store", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              mode: "open"
            },
            listen: {
              bind: "127.0.0.1",
              port: 8787
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(
      issueHasPath(result, "networks.0.server.store") ||
        issueHasPath(result, "networks.0.server")
    ).toBe(true);
  });

  it("accepts external moltnet server mode with bearer auth", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "public_net",
          provider: "moltnet",
          server: {
            mode: "external",
            url: "https://public-net.example",
            auth: {
              mode: "bearer",
              client: {
                token_env: "MOLTNET_BEARER_TOKEN"
              }
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("accepts managed open auth with static token_id client", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              mode: "open",
              client: {
                token_id: "operator",
                static_token: true
              },
              tokens: [
                {
                  id: "operator",
                  secret: "MOLTNET_OPERATOR_TOKEN",
                  scopes: ["admin"]
                }
              ]
            },
            listen: {
              bind: "127.0.0.1",
              port: 8787
            },
            store: {
              kind: "sqlite",
              path: "/tmp/team_net.sqlite"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects managed open auth with non-token-id client source", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              mode: "open",
              client: {
                token_env: "MOLTNET_OPERATOR_TOKEN"
              }
            },
            listen: {
              bind: "127.0.0.1",
              port: 8787
            },
            store: {
              kind: "sqlite",
              path: "/tmp/team_net.sqlite"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) =>
        issue.message.includes("token_id") || issue.message.includes("static_token")
      )
    ).toBe(true);
  });

  it("accepts external open auth with static token_env client", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "public_net",
          provider: "moltnet",
          server: {
            mode: "external",
            url: "https://public-net.example",
            auth: {
              mode: "open",
              client: {
                static_token: true,
                token_env: "MOLTNET_OPEN_TOKEN"
              }
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects external bearer auth with managed token_id client source", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "public_net",
          provider: "moltnet",
          server: {
            mode: "external",
            url: "https://public-net.example",
            auth: {
              mode: "bearer",
              client: {
                token_id: "should_not_work"
              }
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("token_id");
  });

  it("rejects external moltnet servers with managed-only fields", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "public_net",
          provider: "moltnet",
          server: {
            mode: "external",
            url: "https://public-net.example",
            listen: {
              bind: "127.0.0.1",
              port: 8787
            },
            store: {
              kind: "sqlite",
              path: "/tmp/net.sqlite"
            },
            auth: {
              mode: "open"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("listen");
  });

  it("accepts managed moltnet servers with pairings", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
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
              path: "/var/lib/moltnet/team_net.sqlite"
            },
            pairings: [
              {
                id: "partner",
                remote_base_url: "https://partner-network.example",
                remote_network_id: "partner_net",
                remote_network_name: "PartnerNet",
                token_secret: "REMOTE_PARTNER_TOKEN"
              }
            ]
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects external moltnet servers with pairings", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "public_net",
          provider: "moltnet",
          server: {
            mode: "external",
            url: "https://public-net.example",
            auth: {
              mode: "open"
            },
            pairings: [
              {
                id: "partner",
                remote_base_url: "https://partner-network.example",
                remote_network_id: "partner_net",
                remote_network_name: "PartnerNet",
                token_secret: "REMOTE_PARTNER_TOKEN"
              }
            ]
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("rejects managed moltnet servers with bracketed IPv6 bind values", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              mode: "open"
            },
            listen: {
              bind: "[::]",
              port: 8787
            },
            store: {
              kind: "sqlite",
              path: "/var/lib/moltnet/team_net.sqlite"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("unbracketed");
  });

  it("rejects managed moltnet servers with port outside 1..65535", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
          provider: "moltnet",
          server: {
            mode: "managed",
            auth: {
              mode: "open"
            },
            listen: {
              bind: "0.0.0.0",
              port: 70000
            },
            store: {
              kind: "sqlite",
              path: "/var/lib/moltnet/team_net.sqlite"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(issueHasPath(result, "networks.0.server.listen.port")).toBe(true);
  });

  it("rejects top-level docs in manifests", () => {
    const result = manifestSchema.safeParse({
      docs: {
        system: "AGENTS.md"
      },
      kind: "agent",
      name: "worker",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("accepts workspace resources with git and volume entries", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      shared: {
        workspace: {
          resources: [
            {
              id: "project",
              kind: "git",
              url: "https://example.com/example/project.git",
              branch: "main",
              mount: "./repos/project",
              mode: "mutable"
            },
            {
              id: "scratch",
              kind: "volume",
              mount: "${workspace}/scratch",
              mode: "readonly",
              sharing: "team"
            }
          ]
        }
      },
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "resource-cell",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects team-shared git workspace resources", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      shared: {
        workspace: {
          resources: [
            {
              id: "project",
              kind: "git",
              url: "https://example.com/example/project.git",
              branch: "main",
              mount: "./repos/project",
              mode: "mutable",
              sharing: "team"
            }
          ]
        }
      },
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "resource-cell",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("git resources do not support team sharing");
  });

  it("accepts duplicate workspace resource ids when declarations are identical", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      shared: {
        workspace: {
          resources: [
            {
              id: "scratch",
              kind: "volume",
              mount: "/scratch",
              mode: "mutable"
            },
            {
              id: "scratch",
              kind: "volume",
              mount: "/scratch",
              mode: "mutable"
            }
          ]
        }
      },
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "resource-cell",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects duplicate workspace resource ids when declarations differ", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      shared: {
        workspace: {
          resources: [
            {
              id: "project",
              kind: "git",
              url: "https://example.com/example/project.git",
              branch: "main",
              mount: "/workspaces/project",
              mode: "mutable"
            },
            {
              id: "project",
              kind: "git",
              url: "https://example.com/example/project.git",
              tag: "v1",
              mount: "/workspaces/project",
              mode: "mutable"
            }
          ]
        }
      },
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "resource-cell",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("identical");
  });

  it("rejects overlapping workspace resource mounts", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      shared: {
        workspace: {
          resources: [
            {
              id: "project",
              kind: "git",
              url: "https://example.com/example/project.git",
              branch: "main",
              mount: "/workspaces",
              mode: "mutable"
            },
            {
              id: "nested",
              kind: "volume",
              mount: "/workspaces/project",
              mode: "readonly"
            }
          ]
        }
      },
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "resource-cell",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("overlapping mounts");
  });

  it("rejects invalid workspace resource mounts", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      shared: {
        workspace: {
          resources: [
            {
              id: "scratch",
              kind: "volume",
              mount: "scratch",
              mode: "mutable"
            }
          ]
        }
      },
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "resource-cell",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("absolute POSIX");
  });

  it("rejects workspace resource mounts at the workspace root", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      shared: {
        workspace: {
          resources: [
            {
              id: "scratch",
              kind: "volume",
              mount: "${workspace}",
              mode: "mutable"
            }
          ]
        }
      },
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "resource-cell",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("workspace root");
  });

  it("rejects invalid workspace resource mode values", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      shared: {
        workspace: {
          resources: [
            {
              id: "scratch",
              kind: "volume",
              mount: "/scratch",
              mode: "bogus"
            }
          ]
        }
      },
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "resource-cell",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(issueHasPath(result, "shared.workspace.resources.0.mode")).toBe(true);
  });

  it("accepts postgres moltnet store configuration", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
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
              kind: "postgres",
              dsn_secret: "MOLTNET_DATABASE_URL"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects managed moltnet memory store with extra backend fields", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "worker",
          ref: "./agents/worker"
        }
      ],
      mode: "swarm",
      name: "worker-cell",
      networks: [
        {
          id: "team_net",
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
              kind: "memory",
              path: "/tmp/should-not-be-here"
            }
          },
          rooms: [
            {
              id: "workroom",
              members: ["worker"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Unrecognized key");
  });

  it("rejects invalid managed moltnet auth combinations", () => {
    const cases = [
      createManagedServer({
        auth: {
          mode: "none",
          tokens: [{ id: "writer", scopes: ["write"], secret: "MOLTNET_TOKEN" }]
        }
      }),
      createManagedServer({
        auth: { client: { token_env: "MOLTNET_TOKEN" }, mode: "none" }
      }),
      createManagedServer({
        auth: {
          mode: "bearer",
          tokens: [{ id: "writer", scopes: ["attach", "write"], secret: "MOLTNET_TOKEN" }]
        }
      }),
      createManagedServer({
        auth: { client: { token_id: "writer" }, mode: "bearer" }
      }),
      createManagedServer({
        auth: {
          client: { token_env: "MOLTNET_TOKEN" },
          mode: "bearer",
          tokens: [{ id: "writer", scopes: ["attach", "write"], secret: "MOLTNET_TOKEN" }]
        }
      }),
      createManagedServer({
        auth: {
          client: { token_id: "missing" },
          mode: "bearer",
          tokens: [{ id: "writer", scopes: ["attach", "write"], secret: "MOLTNET_TOKEN" }]
        }
      }),
      createManagedServer({
        auth: {
          client: { token_id: "writer" },
          mode: "bearer",
          tokens: [{ id: "writer", scopes: ["attach"], secret: "MOLTNET_TOKEN" }]
        }
      }),
      createManagedServer({
        auth: {
          client: { token_id: "writer" },
          mode: "open",
          tokens: [{ id: "writer", scopes: ["attach", "write"], secret: "MOLTNET_TOKEN" }]
        }
      }),
      createManagedServer({
        auth: {
          client: { static_token: true },
          mode: "open",
          tokens: [{ id: "writer", scopes: ["attach", "write"], secret: "MOLTNET_TOKEN" }]
        }
      }),
      createManagedServer({
        auth: {
          client: { static_token: true, token_env: "MOLTNET_TOKEN" },
          mode: "open",
          tokens: [{ id: "writer", scopes: ["attach", "write"], secret: "MOLTNET_TOKEN" }]
        }
      }),
      createManagedServer({
        auth: {
          mode: "bearer",
          tokens: [
            { id: "writer", scopes: ["attach", "write"], secret: "MOLTNET_TOKEN" },
            { id: "writer", scopes: ["observe"], secret: "MOLTNET_OBSERVER_TOKEN" }
          ],
          client: { token_id: "writer" }
        }
      }),
      createManagedServer({
        listen: { bind: "[::1]", port: 8787 }
      })
    ];

    for (const server of cases) {
      expect(manifestSchema.safeParse(createTeamWithNetwork(server)).success).toBe(false);
    }
  });

  it("rejects invalid external moltnet auth combinations", () => {
    const cases = [
      {
        auth: {
          mode: "bearer",
          tokens: [{ id: "writer", scopes: ["write"], secret: "MOLTNET_TOKEN" }]
        },
        mode: "external",
        url: "https://moltnet.example.com"
      },
      {
        auth: { client: { token_env: "MOLTNET_TOKEN" }, mode: "none" },
        mode: "external",
        url: "https://moltnet.example.com"
      },
      {
        auth: { client: { token_id: "writer" }, mode: "bearer" },
        mode: "external",
        url: "https://moltnet.example.com"
      },
      {
        auth: { client: { token_env: "MOLTNET_TOKEN" }, mode: "open" },
        mode: "external",
        url: "https://moltnet.example.com"
      },
      {
        auth: { client: { static_token: true }, mode: "open" },
        mode: "external",
        url: "https://moltnet.example.com"
      },
      {
        auth: { client: { static_token: true, token_env: "ONE", token_path: "/run/two" }, mode: "open" },
        mode: "external",
        url: "https://moltnet.example.com"
      },
      {
        auth: { client: { static_token: true }, mode: "bearer" },
        mode: "external",
        url: "https://moltnet.example.com"
      }
    ];

    for (const server of cases) {
      expect(manifestSchema.safeParse(createTeamWithNetwork(server)).success).toBe(false);
    }
  });

  it("rejects expose on team manifests", () => {
    const result = manifestSchema.safeParse({
      expose: true,
      kind: "team",
      members: [
        {
          id: "analyst",
          ref: "./agents/analyst"
        }
      ],
      mode: "swarm",
      name: "research-team",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
  });

  it("rejects team manifests that declare execution", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            name: "claude-opus-4-6",
            provider: "anthropic"
          }
        }
      },
      kind: "team",
      members: [
        {
          id: "writer",
          ref: "./agents/writer"
        }
      ],
      mode: "swarm",
      name: "research-team",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("team manifests must not declare execution");
  });

  it("rejects team networks that reference unknown members", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "writer",
          ref: "./agents/writer"
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
              path: "/var/lib/moltnet/team_net.sqlite"
            }
          },
          rooms: [
            {
              id: "research",
              members: ["writer", "reviewer"]
            }
          ]
        }
      ],
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("references unknown member reviewer");
  });

  it("accepts per-model auth and endpoint config for custom models", () => {
    const result = manifestSchema.parse({
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
            name: "claude-sonnet-4-6",
            provider: "custom"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("accepts Discord surfaces on agent manifests", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            guilds: ["123456789012345678"],
            mode: "allowlist",
            users: ["987654321098765432"]
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("accepts Telegram surfaces on agent manifests", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            chats: ["-1001234567890"],
            mode: "allowlist",
            users: ["123456789"]
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("infers Discord allowlist mode from declared users", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            users: ["987654321098765432"]
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("infers Telegram allowlist mode from declared users", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            users: ["123456789"]
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects Discord allowlist access without any allowlist entries", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            mode: "allowlist"
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "discord allowlist access must declare users, guilds, or channels"
    );
  });

  it("rejects Telegram allowlist access without any allowlist entries", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            mode: "allowlist"
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "telegram allowlist access must declare users or chats"
    );
  });

  it("accepts Discord open access without allowlist entries", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            mode: "open"
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("accepts Telegram open access without allowlist entries", () => {
    const result = manifestSchema.parse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            mode: "open"
          }
        }
      }
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects Discord users on non-allowlist access", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {
            mode: "pairing",
            users: ["987654321098765432"]
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "discord access users, guilds, and channels are only valid for allowlist mode"
    );
  });

  it("rejects Telegram allowlist entries on non-allowlist access", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {
            mode: "pairing",
            chats: ["-1001234567890"],
            users: ["123456789"]
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "telegram access users and chats are only valid for allowlist mode"
    );
  });

  it("rejects empty Discord access blocks", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {
          access: {}
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "discord access must declare mode or allowlist entries"
    );
  });

  it("rejects empty Telegram access blocks", () => {
    const result = manifestSchema.safeParse({
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1",
      surfaces: {
        telegram: {
          access: {}
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "telegram access must declare mode or allowlist entries"
    );
  });

  it("rejects team manifests that declare surfaces", () => {
    const result = manifestSchema.safeParse({
      kind: "team",
      members: [
        {
          id: "writer",
          ref: "./agents/writer"
        }
      ],
      mode: "swarm",
      name: "research-team",
      spawnfile_version: "0.1",
      surfaces: {
        discord: {}
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("team manifests must not declare surfaces");
  });

  it("rejects custom api_key models without auth.key", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            auth: {
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
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare auth.key");
  });

  it("rejects inline model auth blocks without method", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            auth: {},
            endpoint: {
              base_url: "https://llm.example.com/v1",
              compatibility: "openai"
            },
            name: "foo-large",
            provider: "custom"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("model auth must declare method");
  });

  it("rejects model auth keys for non-api-key methods", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            auth: {
              key: "OPENAI_API_KEY",
              method: "codex"
            },
            name: "gpt-5.4",
            provider: "openai"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(
      "model auth key is only valid for api_key auth"
    );
  });

  it("rejects custom models without endpoint or auth method", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            name: "foo-large",
            provider: "custom"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "custom models must declare endpoint",
        "custom models must declare auth.method or inherit legacy model auth"
      ])
    );
  });

  it("accepts local models with endpoint and implicit none auth", () => {
    const result = manifestSchema.parse({
      execution: {
        model: {
          primary: {
            endpoint: {
              base_url: "http://host.docker.internal:11434/v1",
              compatibility: "openai"
            },
            name: "qwen2.5:14b",
            provider: "local"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "picoclaw",
      spawnfile_version: "0.1"
    });

    expect(isAgentManifest(result)).toBe(true);
  });

  it("rejects local models without endpoint", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            name: "qwen2.5:14b",
            provider: "local"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "picoclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("local models must declare endpoint");
  });

  it("rejects built-in providers with endpoint overrides", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          primary: {
            endpoint: {
              base_url: "https://proxy.example.com/v1",
              compatibility: "openai"
            },
            name: "gpt-5.4",
            provider: "openai"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("endpoint is only valid");
  });

  it("rejects legacy auth.methods that omit a declared provider", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          auth: {
            methods: {
              openai: "codex"
            }
          },
          fallback: [
            {
              name: "claude-opus-4-6",
              provider: "anthropic"
            }
          ],
          primary: {
            name: "gpt-5.4",
            provider: "openai"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("must declare provider anthropic");
  });

  it("rejects legacy auth.methods that declare unknown providers", () => {
    const result = manifestSchema.safeParse({
      execution: {
        model: {
          auth: {
            methods: {
              anthropic: "claude-code",
              google: "api_key",
              openai: "codex"
            }
          },
          fallback: [
            {
              name: "claude-opus-4-6",
              provider: "anthropic"
            }
          ],
          primary: {
            name: "gpt-5.4",
            provider: "openai"
          }
        }
      },
      kind: "agent",
      name: "agent",
      runtime: "openclaw",
      spawnfile_version: "0.1"
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("declared unknown provider google");
  });
});
