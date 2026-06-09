import { describe, expect, it } from "vitest";

import type { TeamNetworkServer } from "../manifest/index.js";

import { generateMoltnetArtifacts } from "./moltnetArtifacts.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const createManagedServer = (): Extract<TeamNetworkServer, { mode: "managed" }> => ({
  auth: { mode: "none" },
  listen: { bind: "127.0.0.1", port: 8787 },
  mode: "managed",
  store: { kind: "memory" }
});

const createPlan = (): CompilePlan => ({
  edges: [],
  nodes: [
    {
      id: "team-1",
      kind: "team",
      runtimeName: null,
      slug: "research-cell",
      value: {
        description: "",
        docs: [],
        external: ["orchestrator"],
        kind: "team",
        lead: "orchestrator",
        members: [
          {
            id: "orchestrator",
            kind: "agent",
            nodeSource: "/tmp/agents/orchestrator/Spawnfile",
            runtimeName: "openclaw"
          },
          {
            id: "researcher",
            kind: "agent",
            nodeSource: "/tmp/agents/researcher/Spawnfile",
            runtimeName: "picoclaw"
          }
        ],
        mode: "hierarchical",
        name: "research-cell",
        networks: [
          {
            expose: false,
            id: "local_lab",
            name: "Local Lab",
            provider: "moltnet",
            rooms: [
              {
                id: "research",
                members: ["orchestrator", "researcher"],
                visibility: "public",
                write_policy: "members"
              }
            ],
            server: createManagedServer()
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
    },
    {
      id: "agent-1",
      kind: "agent",
      runtimeName: "openclaw",
      slug: "orchestrator",
      value: {
        description: "",
        docs: [],
        env: {},
        execution: undefined,
        kind: "agent",
        mcpServers: [],
        name: "orchestrator-agent",
        policyMode: null,
        policyOnDegrade: null,
        runtime: { name: "openclaw", options: {} },
        secrets: [],
        skills: [],
        source: "/tmp/agents/orchestrator/Spawnfile",
        surfaces: {
          moltnet: [
            {
              dms: {
                enabled: true,
                wake: "all"
              },
              memberId: "orchestrator",
              network: "local_lab",
              rooms: {
                research: {
                  wake: "all"
                }
              },
              teamSource: "/tmp/team/Spawnfile"
            }
          ]
        },
        subagents: []
      }
    }
  ],
  root: "/tmp/team/Spawnfile",
  runtimes: {
    openclaw: { nodeIds: ["agent-1"] }
  }
});

describe("moltnetArtifacts", () => {
  it("returns null when no team networks are declared", async () => {
    const plan = createPlan();
    const [teamNode] = plan.nodes;
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    team.networks = [];

    await expect(generateMoltnetArtifacts(plan)).resolves.toBeNull();
  });

  it(
    "generates server and node artifacts for team networks",
    async () => {
      const artifacts = await generateMoltnetArtifacts(createPlan());

      expect(artifacts).not.toBeNull();
      expect(artifacts?.ports).toEqual([8787]);
      expect(artifacts?.serverPlans).toEqual([
        {
          id: "research-cell-local_lab",
          baseUrl: "http://127.0.0.1:8787",
          configPath:
            "/var/lib/spawnfile/moltnet/servers/research-cell-local_lab/Moltnet.json",
          mode: "managed",
          name: "Local Lab",
          networkId: "local_lab",
          port: 8787,
          rooms: [
            {
              id: "research",
              members: ["orchestrator", "researcher"],
              visibility: "public",
              write_policy: "members"
            }
          ],
          secretPatches: [],
          server: createManagedServer(),
          teamSource: "/tmp/team/Spawnfile"
        }
      ]);
      expect(artifacts?.publishedPorts).toEqual([]);
      expect(artifacts?.nodePlans).toEqual([
        {
          configPath:
            "/var/lib/spawnfile/moltnet/nodes/research-cell-local_lab-orchestrator.json",
          networkId: "local_lab"
        }
      ]);
      expect(artifacts?.files).toHaveLength(2);

      const nodeConfig = artifacts?.files.find((file) =>
        file.path.endsWith("research-cell-local_lab-orchestrator.json")
      );
      expect(nodeConfig?.content).toContain('"version": "moltnet.node.v1"');
      expect(nodeConfig?.content).toContain(
        '"gateway_url": "ws://127.0.0.1:18789"'
      );
      expect(nodeConfig?.content).toContain(
        '"home_path": "/var/lib/spawnfile/instances/openclaw/agent-orchestrator/home"'
      );
      expect(nodeConfig?.content).toContain('"network_id": "local_lab"');
      expect(nodeConfig?.content).not.toContain('"auth_mode"');
    },
    15_000
  );

  it("still emits network sources when no agents attach to moltnet", async () => {
    const plan = createPlan();
    const agentNode = plan.nodes[1];
    if (!agentNode || agentNode.kind !== "agent") {
      throw new Error("expected agent node");
    }

    const agent = agentNode.value as ResolvedAgentNode;
    agent.surfaces = undefined;

    const artifacts = await generateMoltnetArtifacts(plan);
    expect(artifacts?.nodePlans).toEqual([]);
    expect(artifacts?.serverPlans).toHaveLength(1);
    expect(artifacts?.publishedPorts).toEqual([]);
    expect(artifacts?.files).toHaveLength(1);
  });

  it("emits direct pico command and tinyclaw runtime ingress config", async () => {
    const plan = createPlan();
    plan.nodes.push(
      {
        id: "agent-2",
        kind: "agent",
        runtimeName: "picoclaw",
        slug: "researcher",
        value: {
          description: "",
          docs: [],
          env: {},
          execution: undefined,
          kind: "agent",
          mcpServers: [],
          name: "researcher-agent",
          policyMode: null,
          policyOnDegrade: null,
          runtime: { name: "picoclaw", options: {} },
          secrets: [],
          skills: [],
          source: "/tmp/agents/researcher/Spawnfile",
          surfaces: {
            moltnet: [
              {
                memberId: "researcher",
                network: "local_lab",
                rooms: {
                  research: {
                    wake: "all"
                  }
                },
                teamSource: "/tmp/team/Spawnfile"
              }
            ]
          },
          subagents: []
        }
      },
      {
        id: "agent-3",
        kind: "agent",
        runtimeName: "tinyclaw",
        slug: "assistant",
        value: {
          description: "",
          docs: [],
          env: {},
          execution: undefined,
          kind: "agent",
          mcpServers: [],
          name: "assistant-agent",
          policyMode: null,
          policyOnDegrade: null,
          runtime: { name: "tinyclaw", options: {} },
          secrets: [],
          skills: [],
          source: "/tmp/agents/assistant/Spawnfile",
          surfaces: {
            moltnet: [
              {
                memberId: "assistant",
                network: "local_lab",
                rooms: {
                  research: {
                    wake: "all"
                  }
                },
                teamSource: "/tmp/team/Spawnfile"
              }
            ]
          },
          subagents: []
        }
      }
    );

    const artifacts = await generateMoltnetArtifacts(plan);
    const researcherConfig = artifacts?.files.find((file) =>
      file.path.endsWith("research-cell-local_lab-researcher.json")
    );
    const assistantConfig = artifacts?.files.find((file) =>
      file.path.endsWith("research-cell-local_lab-assistant.json")
    );

    expect(researcherConfig?.content).toContain('"command": "/usr/local/bin/picoclaw"');
    expect(researcherConfig?.content).toContain(
      '"config_path": "/var/lib/spawnfile/instances/picoclaw/agent-researcher/picoclaw/config.json"'
    );
    expect(researcherConfig?.content).toContain(
      '"home_path": "/var/lib/spawnfile/instances/picoclaw/agent-researcher/picoclaw"'
    );
    expect(assistantConfig?.content).toContain('"inbound_url": "http://127.0.0.1:3777/api/message"');
    expect(assistantConfig?.content).toContain('"ack_url": "http://127.0.0.1:3777/api/responses"');
    expect(assistantConfig?.content).toContain(
      '"outbound_url": "http://127.0.0.1:3777/api/responses/pending?channel=moltnet%3Alocal_lab%3Aassistant"'
    );
  });

  it("publishes only managed networks with human ingress enabled", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    const server = team.networks?.[0]?.server;
    if (server?.mode === "managed") {
      server.human_ingress = true;
    }

    const artifacts = await generateMoltnetArtifacts(plan);
    expect(artifacts?.publishedPorts).toEqual([8787]);
  });

  it("reports persistent mounts for durable managed Moltnet stores", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    if (team.networks?.[0]) {
      team.networks[0].server = {
        ...createManagedServer(),
        store: {
          kind: "sqlite",
          persistence: { mode: "durable", name: "custom-local-lab-state" }
        }
      };
    }

    const artifacts = await generateMoltnetArtifacts(plan);
    const serverConfig = artifacts?.files.find((file) =>
      file.path.endsWith("Moltnet.json")
    );

    expect(serverConfig?.content).toContain(
      '"/var/lib/spawnfile/moltnet/networks/local_lab/moltnet.sqlite"'
    );
    expect(artifacts?.persistentMounts).toEqual([
      {
        id: "moltnet-local_lab-store",
        mountPath: "/var/lib/spawnfile/moltnet/networks/local_lab",
        reason: "managed Moltnet sqlite store for local_lab",
        volumeName: "custom-local-lab-state"
      }
    ]);
  });

  it("merges teams that reuse the same moltnet network id into one server plan", async () => {
    const plan = createPlan();
    const rootTeam = plan.nodes[0];
    if (!rootTeam || rootTeam.kind !== "team") {
      throw new Error("expected root team node");
    }
    const rootNetwork = (rootTeam.value as ResolvedTeamNode).networks?.[0];
    if (rootNetwork?.server?.mode === "managed") {
      rootNetwork.server.human_ingress = true;
    }
    plan.nodes.push(
      {
        id: "team-2",
        kind: "team",
        runtimeName: null,
        slug: "quality-cell",
        value: {
          description: "",
          docs: [],
          external: ["reviewer"],
          kind: "team",
          lead: "reviewer",
          members: [
            {
              id: "reviewer",
              kind: "agent",
              nodeSource: "/tmp/agents/reviewer/Spawnfile",
              runtimeName: "openclaw"
            }
          ],
          mode: "hierarchical",
          name: "quality-cell",
          networks: [
            {
              expose: true,
              id: "local_lab",
              name: "Local Lab",
              provider: "moltnet",
              rooms: [
                {
                  id: "quality",
                  members: ["reviewer"]
                }
              ],
              server: {
                ...createManagedServer(),
                human_ingress: true
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
          source: "/tmp/quality/Spawnfile"
        }
      },
      {
        id: "agent-2",
        kind: "agent",
        runtimeName: "openclaw",
        slug: "reviewer",
        value: {
          description: "",
          docs: [],
          env: {},
          execution: undefined,
          kind: "agent",
          mcpServers: [],
          name: "reviewer-agent",
          policyMode: null,
          policyOnDegrade: null,
          runtime: { name: "openclaw", options: {} },
          secrets: [],
          skills: [],
          source: "/tmp/agents/reviewer/Spawnfile",
          surfaces: {
            moltnet: [
              {
                memberId: "reviewer",
                network: "local_lab",
                rooms: {
                  quality: {
                    wake: "all"
                  }
                },
                teamSource: "/tmp/quality/Spawnfile"
              }
            ]
          },
          subagents: []
        }
      }
    );
    plan.runtimes.openclaw.nodeIds.push("agent-2");

    const artifacts = await generateMoltnetArtifacts(plan);

    expect(artifacts?.ports).toEqual([8787]);
    expect(artifacts?.publishedPorts).toEqual([8787]);
    expect(artifacts?.serverPlans).toHaveLength(1);
    expect(artifacts?.files.filter((file) => file.path.endsWith("Moltnet.json"))).toHaveLength(1);
    expect(artifacts?.serverPlans[0]?.rooms).toEqual([
      {
        id: "quality",
        members: ["reviewer"]
      },
      {
        id: "research",
        members: ["orchestrator", "researcher"],
        visibility: "public",
        write_policy: "members"
      }
    ]);
    expect(artifacts?.nodePlans).toContainEqual({
      configPath: "/var/lib/spawnfile/moltnet/nodes/quality-cell-local_lab-reviewer.json",
      networkId: "local_lab"
    });
    expect(
      artifacts?.files.find((file) => file.path.endsWith("quality-cell-local_lab-reviewer.json"))
        ?.content
    ).toContain('"base_url": "http://127.0.0.1:8787"');
  });

  it("serializes room and dm policy details into node configs", async () => {
    const plan = createPlan();
    const agentNode = plan.nodes[1];
    if (!agentNode || agentNode.kind !== "agent") {
      throw new Error("expected agent node");
    }

    const agent = agentNode.value as ResolvedAgentNode;
    agent.surfaces = {
      moltnet: [
        {
          dms: {
            enabled: true,
            wake: "never"
          },
          memberId: "orchestrator",
          network: "local_lab",
          rooms: {
            research: {
              wake: "mentions"
            }
          },
          teamSource: "/tmp/team/Spawnfile"
        }
      ]
    };

    const artifacts = await generateMoltnetArtifacts(plan);
    const nodeConfig = artifacts?.files.find((file) =>
      file.path.endsWith("research-cell-local_lab-orchestrator.json")
    );

    expect(nodeConfig?.content).toContain('"rooms": [');
    expect(nodeConfig?.content).toContain('"visibility": "public"');
    expect(nodeConfig?.content).toContain('"write_policy": "members"');
    expect(nodeConfig?.content).toContain('"wake": "mentions"');
    expect(nodeConfig?.content).toContain('"wake": "never"');
    expect(nodeConfig?.content).not.toContain('"reply"');
    expect(nodeConfig?.content).toContain('"dms": {');
  });

  it("places generated open registration tokens on the attachment", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    const agentNode = plan.nodes[1];
    if (!teamNode || teamNode.kind !== "team" || !agentNode || agentNode.kind !== "agent") {
      throw new Error("expected team and agent nodes");
    }

    const team = teamNode.value as ResolvedTeamNode;
    const agent = agentNode.value as ResolvedAgentNode;
    if (team.networks?.[0]) {
      team.networks[0].server = {
        ...createManagedServer(),
        auth: { mode: "open" }
      };
    }
    if (agent.surfaces?.moltnet?.[0]) {
      agent.surfaces.moltnet[0].rooms = undefined;
      agent.surfaces.moltnet[0].dms = undefined;
    }

    const artifacts = await generateMoltnetArtifacts(plan);
    const nodeConfig = artifacts?.files.find((file) =>
      file.path.endsWith("research-cell-local_lab-orchestrator.json")
    );
    const parsed = JSON.parse(nodeConfig?.content ?? "{}") as {
      attachments?: Array<{ moltnet?: { token_path?: string }; rooms?: unknown }>;
      moltnet?: { registration?: string; token_path?: string };
    };

    expect(parsed.moltnet?.token_path).toBeUndefined();
    expect(parsed.moltnet?.registration).toBe("open");
    expect(parsed.attachments?.[0]?.moltnet?.token_path)
      .toBe("/var/lib/spawnfile/agents/orchestrator/state/moltnet/local_lab-orchestrator.token");
    expect(parsed.attachments?.[0]?.rooms).toBeUndefined();
    expect(artifacts?.persistentMounts).toEqual([
      expect.objectContaining({
        id: "agent-orchestrator-moltnet-tokens",
        mountPath: "/var/lib/spawnfile/agents/orchestrator/state/moltnet",
        reason: "Moltnet open-mode generated agent tokens for orchestrator-agent"
      })
    ]);
  });

  it("uses open self-claiming node auth for bearer servers with open registration", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    if (team.networks?.[0]) {
      team.networks[0].server = {
        ...createManagedServer(),
        auth: {
          agent_registration: "open",
          mode: "bearer",
          public_read: true,
          tokens: [
            {
              id: "operator",
              scopes: ["admin", "write"],
              secret: "MOLTNET_OPERATOR_TOKEN"
            }
          ]
        }
      };
    }

    const artifacts = await generateMoltnetArtifacts(plan);
    const nodeConfig = artifacts?.files.find((file) =>
      file.path.endsWith("research-cell-local_lab-orchestrator.json")
    );
    const parsed = JSON.parse(nodeConfig?.content ?? "{}") as {
      attachments?: Array<{ moltnet?: { token_path?: string } }>;
      moltnet?: { auth_mode?: string; registration?: string };
    };

    expect(parsed.moltnet?.auth_mode).toBe("open");
    expect(parsed.moltnet?.registration).toBe("open");
    expect(parsed.attachments?.[0]?.moltnet?.token_path)
      .toBe("/var/lib/spawnfile/agents/orchestrator/state/moltnet/local_lab-orchestrator.token");
  });

  it("rejects reused network rooms with conflicting access policy", async () => {
    const plan = createPlan();
    plan.nodes.push({
      id: "team-2",
      kind: "team",
      runtimeName: null,
      slug: "observer-cell",
      value: {
        description: "",
        docs: [],
        external: [],
        kind: "team",
        lead: null,
        members: [],
        mode: "swarm",
        name: "observer-cell",
        networks: [
          {
            id: "local_lab",
            name: "Local Lab",
            provider: "moltnet",
            rooms: [
              {
                id: "research",
                members: [],
                visibility: "private",
                write_policy: "operators"
              }
            ],
            server: createManagedServer()
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
        source: "/tmp/observer/Spawnfile"
      }
    });

    await expect(generateMoltnetArtifacts(plan)).rejects.toThrow(
      /conflicting visibility: public vs private/
    );
  });

  it("rejects reused networks with conflicting server auth policy", async () => {
    const cases = [
      {
        auth: { mode: "open" as const },
        message: /conflicting server\.auth policy/
      },
      {
        auth: { mode: "none" as const, public_read: false },
        message: /conflicting server\.auth policy/
      },
      {
        auth: { mode: "none" as const, agent_registration: "open" as const },
        message: /conflicting server\.auth policy/
      }
    ];

    for (const testCase of cases) {
      const plan = createPlan();
      plan.nodes.push({
        id: "team-2",
        kind: "team",
        runtimeName: null,
        slug: "observer-cell",
        value: {
          description: "",
          docs: [],
          external: [],
          kind: "team",
          lead: null,
          members: [],
          mode: "swarm",
          name: "observer-cell",
          networks: [
            {
              id: "local_lab",
              name: "Local Lab",
              provider: "moltnet",
              rooms: [{ id: "research", members: [] }],
              server: { ...createManagedServer(), auth: testCase.auth }
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
          source: "/tmp/observer/Spawnfile"
        }
      });

      await expect(generateMoltnetArtifacts(plan)).rejects.toThrow(testCase.message);
    }
  });

  it("rejects reused networks with conflicting managed server definitions", async () => {
    const cases: Array<{
      name: string;
      networkName?: string;
      server: Extract<TeamNetworkServer, { mode: "managed" }>;
      message: RegExp;
    }> = [
      {
        name: "listen",
        server: {
          ...createManagedServer(),
          listen: { bind: "127.0.0.1", port: 8788 }
        },
        message: /conflicting server URL/
      },
      {
        name: "direct messages",
        server: {
          ...createManagedServer(),
          direct_messages: false
        },
        message: /conflicting server definition/
      },
      {
        name: "store",
        server: {
          ...createManagedServer(),
          store: { kind: "sqlite", path: "/var/lib/moltnet/other.sqlite" }
        },
        message: /conflicting server definition/
      },
      {
        name: "name",
        networkName: "Different Lab",
        server: createManagedServer(),
        message: /conflicting network name/
      }
    ];

    for (const testCase of cases) {
      const plan = createPlan();
      plan.nodes.push({
        id: "team-2",
        kind: "team",
        runtimeName: null,
        slug: "observer-cell",
        value: {
          description: "",
          docs: [],
          external: [],
          kind: "team",
          lead: null,
          members: [],
          mode: "swarm",
          name: "observer-cell",
          networks: [
            {
              id: "local_lab",
              name: testCase.networkName ?? "Local Lab",
              provider: "moltnet",
              rooms: [{ id: "observation", members: [] }],
              server: testCase.server
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
          source: "/tmp/observer/Spawnfile"
        }
      });

      await expect(generateMoltnetArtifacts(plan), testCase.name).rejects.toThrow(testCase.message);
    }
  });

  it("keeps external network plans out of managed server ports and configs", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    team.networks?.push({
      id: "remote_lab",
      name: "Remote Lab",
      provider: "moltnet",
      rooms: [
        {
          id: "remote-room",
          members: ["orchestrator"]
        }
      ],
      server: {
        auth: { mode: "none" },
        mode: "external",
        url: "https://remote.example.com"
      }
    });

    const artifacts = await generateMoltnetArtifacts(plan);

    expect(artifacts?.ports).toEqual([8787]);
    expect(artifacts?.publishedPorts).toEqual([]);
    expect(artifacts?.serverPlans.map((entry) => [entry.networkId, entry.mode, entry.baseUrl]))
      .toEqual([
        ["local_lab", "managed", "http://127.0.0.1:8787"],
        ["remote_lab", "external", "https://remote.example.com"]
      ]);
    expect(artifacts?.files.some((file) => file.path.includes("remote_lab"))).toBe(false);
  });

  it("serializes external bearer token sources into node config", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    if (team.networks?.[0]) {
      team.networks[0].server = {
        auth: {
          client: { token_path: "/run/secrets/moltnet-token" },
          mode: "bearer"
        },
        mode: "external",
        url: "https://remote.example.com"
      };
    }

    const artifacts = await generateMoltnetArtifacts(plan);
    const nodeConfig = artifacts?.files.find((file) =>
      file.path.endsWith("research-cell-local_lab-orchestrator.json")
    );

    expect(artifacts?.ports).toEqual([]);
    expect(nodeConfig?.content).toContain('"base_url": "https://remote.example.com"');
    expect(nodeConfig?.content).toContain('"auth_mode": "bearer"');
    expect(nodeConfig?.content).toContain('"token_path": "/run/secrets/moltnet-token"');
  });

  it("serializes external token env sources into node config", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    if (team.networks?.[0]) {
      team.networks[0].server = {
        auth: {
          client: { static_token: true, token_env: "MOLTNET_STATIC_TOKEN" },
          mode: "open"
        },
        mode: "external",
        url: "https://remote.example.com"
      };
    }

    const artifacts = await generateMoltnetArtifacts(plan);
    const nodeConfig = artifacts?.files.find((file) =>
      file.path.endsWith("research-cell-local_lab-orchestrator.json")
    );

    expect(nodeConfig?.content).toContain('"auth_mode": "open"');
    expect(nodeConfig?.content).toContain('"static_token": true');
    expect(nodeConfig?.content).toContain('"token_env": "MOLTNET_STATIC_TOKEN"');
  });

  it("rejects attachments without a resolved team context", async () => {
    const plan = createPlan();
    const agentNode = plan.nodes[1];
    if (!agentNode || agentNode.kind !== "agent") {
      throw new Error("expected agent node");
    }

    const agent = agentNode.value as ResolvedAgentNode;
    agent.surfaces = {
      moltnet: [
        {
          memberId: null,
          network: "local_lab",
          teamSource: null
        }
      ]
    };

    await expect(generateMoltnetArtifacts(plan)).rejects.toThrow(/require a team-bound network context/);
  });

  it("rejects attachments that reference missing team sources", async () => {
    const plan = createPlan();
    const agentNode = plan.nodes[1];
    if (!agentNode || agentNode.kind !== "agent") {
      throw new Error("expected agent node");
    }

    const agent = agentNode.value as ResolvedAgentNode;
    agent.surfaces = {
      moltnet: [
        {
          memberId: "orchestrator",
          network: "local_lab",
          teamSource: "/tmp/missing-team/Spawnfile"
        }
      ]
    };

    await expect(generateMoltnetArtifacts(plan)).rejects.toThrow(/Unable to find team context/);
  });

  it("rejects attachments that reference missing team networks", async () => {
    const plan = createPlan();
    const agentNode = plan.nodes[1];
    if (!agentNode || agentNode.kind !== "agent") {
      throw new Error("expected agent node");
    }

    const agent = agentNode.value as ResolvedAgentNode;
    agent.surfaces = {
      moltnet: [
        {
          memberId: "orchestrator",
          network: "missing",
          teamSource: "/tmp/team/Spawnfile"
        }
      ]
    };

    await expect(generateMoltnetArtifacts(plan)).rejects.toThrow(/Unable to find Moltnet network missing/);
  });

  it("rejects duplicate node attachments for the same network member", async () => {
    const plan = createPlan();
    const agentNode = plan.nodes[1];
    if (!agentNode || agentNode.kind !== "agent") {
      throw new Error("expected agent node");
    }

    const agent = agentNode.value as ResolvedAgentNode;
    agent.surfaces = {
      moltnet: [
        {
          memberId: "orchestrator",
          network: "local_lab",
          rooms: { research: {} },
          teamSource: "/tmp/team/Spawnfile"
        },
        {
          memberId: "orchestrator",
          network: "local_lab",
          teamSource: "/tmp/team/Spawnfile"
        }
      ]
    };

    await expect(generateMoltnetArtifacts(plan)).rejects.toThrow(
      /Duplicate Moltnet node attachment/
    );
  });

  it("rejects direct messages when the network disables them", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    if (team.networks?.[0]?.server?.mode === "managed") {
      team.networks[0].server.direct_messages = false;
    }

    await expect(generateMoltnetArtifacts(plan)).rejects.toThrow(
      /disables direct messages/
    );
  });

  it("rejects direct moltnet node configs for unsupported runtimes", async () => {
    const plan = createPlan();
    plan.nodes.push({
      id: "agent-unsupported",
      kind: "agent",
      runtimeName: "zeroclaw",
      slug: "unsupported",
      value: {
        description: "",
        docs: [],
        env: {},
        execution: undefined,
        kind: "agent",
        mcpServers: [],
        name: "unsupported-agent",
        policyMode: null,
        policyOnDegrade: null,
        runtime: { name: "zeroclaw", options: {} },
        secrets: [],
        skills: [],
        source: "/tmp/agents/unsupported/Spawnfile",
        surfaces: {
          moltnet: [
            {
              memberId: "unsupported",
              network: "local_lab",
              rooms: {
                research: {}
              },
              teamSource: "/tmp/team/Spawnfile"
            }
          ]
        },
        subagents: []
      }
    });

    await expect(generateMoltnetArtifacts(plan)).rejects.toThrow(
      /does not know how to attach runtime zeroclaw/
    );
  });
});
