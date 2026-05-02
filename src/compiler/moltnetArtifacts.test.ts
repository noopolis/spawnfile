import { describe, expect, it } from "vitest";

import { generateMoltnetArtifacts } from "./moltnetArtifacts.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

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
                members: ["orchestrator", "researcher"]
              }
            ]
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
                read: "all",
                reply: "auto"
              },
              memberId: "orchestrator",
              network: "local_lab",
              rooms: {
                research: {
                  read: "all",
                  reply: "auto"
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
    "generates server and bridge artifacts for team networks",
    async () => {
      const artifacts = await generateMoltnetArtifacts(createPlan());

      expect(artifacts).not.toBeNull();
      expect(artifacts?.ports).toEqual([8787]);
      expect(artifacts?.serverPlans).toEqual([
        {
          id: "research-cell-local_lab",
          name: "Local Lab",
          networkId: "local_lab",
          port: 8787,
          rooms: [
            {
              id: "research",
              members: ["orchestrator", "researcher"]
            }
          ],
          teamSource: "/tmp/team/Spawnfile"
        }
      ]);
      expect(artifacts?.publishedPorts).toEqual([]);
      expect(artifacts?.bridgePlans).toEqual([
        {
          agentId: "orchestrator",
          configPath:
            "/var/lib/spawnfile/moltnet/bridges/research-cell-local_lab-orchestrator.json",
          networkId: "local_lab",
          runtime: "openclaw"
        }
      ]);
      expect(artifacts?.files).toHaveLength(1);

      const bridgeConfig = artifacts?.files.find((file) =>
        file.path.endsWith("research-cell-local_lab-orchestrator.json")
      );
      expect(bridgeConfig?.content).toContain(
        '"gateway_url": "ws://127.0.0.1:18789"'
      );
      expect(bridgeConfig?.content).toContain(
        '"home_path": "/var/lib/spawnfile/instances/openclaw/agent-orchestrator/home"'
      );
      expect(bridgeConfig?.content).toContain('"network_id": "local_lab"');
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
    expect(artifacts?.bridgePlans).toEqual([]);
    expect(artifacts?.serverPlans).toHaveLength(1);
    expect(artifacts?.publishedPorts).toEqual([]);
    expect(artifacts?.files).toEqual([]);
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
                    read: "all",
                    reply: "auto"
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
                    read: "all",
                    reply: "auto"
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

  it("publishes only networks marked expose: true", async () => {
    const plan = createPlan();
    const teamNode = plan.nodes[0];
    if (!teamNode || teamNode.kind !== "team") {
      throw new Error("expected team node");
    }

    const team = teamNode.value as ResolvedTeamNode;
    if (team.networks?.[0]) {
      team.networks[0].expose = true;
    }

    const artifacts = await generateMoltnetArtifacts(plan);
    expect(artifacts?.publishedPorts).toEqual([8787]);
  });

  it("merges teams that reuse the same moltnet network id into one server plan", async () => {
    const plan = createPlan();
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
              ]
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
                    read: "all"
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
    expect(artifacts?.serverPlans[0]?.rooms).toEqual([
      {
        id: "quality",
        members: ["reviewer"]
      },
      {
        id: "research",
        members: ["orchestrator", "researcher"]
      }
    ]);
    expect(artifacts?.bridgePlans).toContainEqual({
      agentId: "reviewer",
      configPath: "/var/lib/spawnfile/moltnet/bridges/quality-cell-local_lab-reviewer.json",
      networkId: "local_lab",
      runtime: "openclaw"
    });
    expect(
      artifacts?.files.find((file) => file.path.endsWith("quality-cell-local_lab-reviewer.json"))
        ?.content
    ).toContain('"base_url": "http://127.0.0.1:8787"');
  });

  it("serializes room and dm policy details into bridge configs", async () => {
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
            read: "mentions",
            reply: "never"
          },
          memberId: "orchestrator",
          network: "local_lab",
          rooms: {
            research: {
              read: "mentions",
              reply: "auto"
            }
          },
          teamSource: "/tmp/team/Spawnfile"
        }
      ]
    };

    const artifacts = await generateMoltnetArtifacts(plan);
    const bridgeConfig = artifacts?.files.find((file) =>
      file.path.endsWith("research-cell-local_lab-orchestrator.json")
    );

    expect(bridgeConfig?.content).toContain('"rooms": [');
    expect(bridgeConfig?.content).toContain('"read": "mentions"');
    expect(bridgeConfig?.content).toContain('"reply": "auto"');
    expect(bridgeConfig?.content).toContain('"reply": "never"');
    expect(bridgeConfig?.content).not.toContain('"reply": "manual"');
    expect(bridgeConfig?.content).toContain('"dms": {');
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

  it("rejects duplicate bridge attachments for the same network member", async () => {
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
      /Duplicate Moltnet bridge attachment/
    );
  });

  it("rejects direct moltnet bridge configs for unsupported runtimes", async () => {
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
