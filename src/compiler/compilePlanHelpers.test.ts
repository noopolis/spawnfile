import { describe, expect, it } from "vitest";

import {
  getAgentFingerprint,
  getMcpNames,
  getTeamFingerprint,
  listMoltnetNetworkSecretNames,
  mergePackages,
  validateEffectiveSkillRequirements
} from "./compilePlanHelpers.js";
import type { CompilePlanNode } from "./types.js";

describe("compilePlanHelpers", () => {
  it("collects MCP server names", () => {
    expect(
      [...getMcpNames([{ name: "search" }, { name: "filesystem" }, { name: "search" }])]
    ).toEqual(["search", "filesystem"]);
  });

  it("validates skill MCP requirements", () => {
    expect(() =>
      validateEffectiveSkillRequirements(
        "researcher",
        new Set(["search", "filesystem"]),
        [
          {
            content: "",
            name: "research",
            ref: "./skills/research",
            requiresMcp: ["search"],
            sourcePath: "/tmp/skills/research/SKILL.md"
          }
        ]
      )
    ).not.toThrow();

    expect(() =>
      validateEffectiveSkillRequirements(
        "researcher",
        new Set(["filesystem"]),
        [
          {
            content: "",
            name: "research",
            ref: "./skills/research",
            requiresMcp: ["search"],
            sourcePath: "/tmp/skills/research/SKILL.md"
          }
        ]
      )
    ).toThrow(/requires undeclared MCP server: search/);
  });

  it("includes surfaces and networks in fingerprints", () => {
    const baseAgent = {
      description: "",
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent" as const,
      mcpServers: [],
      name: "researcher",
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "openclaw" as const, options: {} },
      secrets: [],
      skills: [],
      source: "/tmp/agents/researcher/Spawnfile",
      subagents: []
    };

    expect(
      getAgentFingerprint({
        ...baseAgent,
        surfaces: {
          moltnet: [{ memberId: "researcher", network: "local_lab", teamSource: "/tmp/team/Spawnfile" }]
        }
      })
    ).not.toBe(
      getAgentFingerprint({
        ...baseAgent,
        surfaces: undefined
      })
    );

    const baseTeam = {
      description: "",
      docs: [],
      external: ["researcher"],
      kind: "team" as const,
      lead: "researcher",
      members: [],
      mode: "hierarchical" as const,
      name: "research-cell",
      policyMode: null,
      policyOnDegrade: null,
      shared: {
        env: {},
        mcpServers: [],
        secrets: [],
        skills: []
      },
      source: "/tmp/team/Spawnfile"
    };

    expect(
      getTeamFingerprint({
        ...baseTeam,
        networks: [
          {
            id: "local_lab",
            name: "Local Lab",
            provider: "moltnet",
            rooms: [{ id: "research", members: ["researcher"] }]
          }
        ]
      })
    ).not.toBe(
      getTeamFingerprint({
        ...baseTeam,
        networks: []
      })
    );
  });

  it("collects Moltnet network secret names", () => {
    const planNodes: CompilePlanNode[] = [
      {
        id: "team-node",
        kind: "team" as const,
        runtimeName: null,
        slug: "team-node",
        value: {
          description: "",
          docs: [],
          external: [],
          kind: "team" as const,
          lead: "leader",
          members: [],
          mode: "hierarchical" as const,
          name: "mesh",
          networks: [
            {
              id: "managed-bearer",
              name: "managed bearer",
              provider: "moltnet",
              rooms: [],
              server: {
                auth: {
                  client: {
                    token_id: "attach"
                  },
                  mode: "bearer",
                  tokens: [
                    {
                      agents: ["leader"],
                      id: "attach",
                      secret: "MOLTNET_ATTACH_TOKEN",
                      scopes: ["attach", "write", "observe"]
                    }
                  ]
                },
                direct_messages: false,
                listen: {
                  bind: "127.0.0.1",
                  port: 8787
                },
                mode: "managed",
                pairings: [
                  {
                    id: "remote-pairing",
                    remote_base_url: "https://remote.example.com",
                    remote_network_id: "remote",
                    remote_network_name: "Remote",
                    token_secret: "REMOTE_NET_PAIR_TOKEN"
                  }
                ],
                store: {
                  kind: "postgres",
                  dsn_secret: "MOLTNET_DSN"
                },
                url: "http://127.0.0.1:8787"
              }
            },
            {
              id: "external-bearer",
              name: "external bearer",
              provider: "moltnet",
              rooms: [],
              server: {
                auth: {
                  client: {
                    token_env: "MOLTNET_BEARER_ENV"
                  },
                  mode: "bearer"
                },
                mode: "external",
                url: "https://moltnet.example.com"
              }
            },
            {
              id: "managed-open-self",
              name: "managed open",
              provider: "moltnet",
              rooms: [],
              server: {
                auth: {
                  mode: "open"
                },
                listen: {
                  bind: "127.0.0.1",
                  port: 8788
                },
                mode: "managed",
                store: {
                  kind: "postgres",
                  dsn_secret: "OPEN_DSN"
                }
              }
            }
          ],
          policyMode: null,
          policyOnDegrade: null,
          shared: {
            env: {},
            mcpServers: [],
            secrets: [],
            skills: []
          },
          source: "/tmp/team/Spawnfile"
        }
      }
    ];

    expect(listMoltnetNetworkSecretNames(planNodes)).toEqual([
      "MOLTNET_ATTACH_TOKEN",
      "MOLTNET_BEARER_ENV",
      "MOLTNET_DSN",
      "OPEN_DSN",
      "REMOTE_NET_PAIR_TOKEN"
    ]);
  });

  it("dedupes package declarations and lets local versions override shared versions", () => {
    const sharedPackages = [
      {
        id: "apt-gh-shared",
        manager: "apt" as const,
        name: "gh",
        version: "2.42.0"
      },
      {
        id: "apt-git",
        manager: "apt",
        name: "git"
      }
    ];
    const localPackages = [
      {
        id: "apt-gh-agent",
        manager: "apt" as const,
        name: "gh",
        version: "2.50.0"
      },
      {
        id: "pipx-yt-dlp",
        manager: "pipx",
        name: "yt-dlp"
      }
    ];

    expect(mergePackages(sharedPackages, localPackages)).toEqual([
      localPackages[0],
      sharedPackages[1],
      localPackages[1]
    ]);
  });
});
