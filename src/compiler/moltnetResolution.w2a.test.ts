import { describe, expect, it } from "vitest";

import { resolvePlanMoltnetAttachments } from "./moltnetResolution.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const createAgent = (surfaces: ResolvedAgentNode["surfaces"]): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name: "rep-agent",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/child/agents/rep/Spawnfile",
  surfaces,
  subagents: []
});

const createTeam = (overrides: Partial<ResolvedTeamNode>): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  externalExplicit: false,
  kind: "team",
  lead: null,
  members: [],
  mode: "swarm",
  name: "team",
  networks: [],
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: "/tmp/team/Spawnfile",
  ...overrides
});

describe("moltnetResolution w2a", () => {
  it("accepts duplicate dm policies that are semantically identical despite insertion order", () => {
    const agent = createAgent({
      moltnet: [
        {
          dms: {
            wake: "all",
            enabled: true,
            allowedWakeSenders: ["world"]
          },
          memberId: null,
          network: "org",
          teamSource: null
        },
        {
          dms: {
            allowedWakeSenders: ["world"],
            enabled: true,
            wake: "all"
          },
          memberId: null,
          network: "org",
          teamSource: null
        }
      ]
    });

    const team = createTeam({
      members: [
        {
          id: "rep",
          kind: "agent",
          nodeSource: agent.source,
          runtimeName: "openclaw"
        }
      ],
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: []
        }
      ]
    });

    const plan: CompilePlan = {
      edges: [],
      memberships: [
        {
          agentSource: agent.source,
          memberId: "rep",
          teamName: team.name,
          teamSource: team.source
        }
      ],
      nodes: [
        { id: "agent", kind: "agent", runtimeName: "openclaw", slug: "rep", value: agent },
        { id: "team", kind: "team", runtimeName: null, slug: "team", value: team }
      ],
      root: team.source,
      runtimes: { openclaw: { nodeIds: ["agent"] } }
    };

    expect(() => resolvePlanMoltnetAttachments(plan)).not.toThrow();
    expect(agent.surfaces?.moltnet?.[0]).toMatchObject({
      dms: {
        enabled: true,
        wake: "all",
        allowedWakeSenders: ["world"]
      },
      memberId: "rep",
      network: "org",
      rooms: {},
      teamSource: team.source
    });
  });

  it("rejects duplicate dm policies when allowed_wake_senders order differs", () => {
    const agent = createAgent({
      moltnet: [
        {
          dms: {
            enabled: true,
            allowedWakeSenders: ["world", "neighbor"]
          },
          memberId: null,
          network: "org",
          teamSource: null
        },
        {
          dms: {
            enabled: true,
            allowedWakeSenders: ["neighbor", "world"]
          },
          memberId: null,
          network: "org",
          teamSource: null
        }
      ]
    });

    const team = createTeam({
      members: [
        {
          id: "rep",
          kind: "agent",
          nodeSource: agent.source,
          runtimeName: "openclaw"
        }
      ],
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: []
        }
      ]
    });

    const plan: CompilePlan = {
      edges: [],
      memberships: [
        {
          agentSource: agent.source,
          memberId: "rep",
          teamName: team.name,
          teamSource: team.source
        }
      ],
      nodes: [
        { id: "agent", kind: "agent", runtimeName: "openclaw", slug: "rep", value: agent },
        { id: "team", kind: "team", runtimeName: null, slug: "team", value: team }
      ],
      root: team.source,
      runtimes: { openclaw: { nodeIds: ["agent"] } }
    };

    expect(() => resolvePlanMoltnetAttachments(plan)).toThrow(/incompatible Moltnet dms/);
  });

  it("rejects duplicate dm policies when one is missing allowed_wake_senders", () => {
    const agent = createAgent({
      moltnet: [
        {
          dms: { enabled: true },
          memberId: null,
          network: "org",
          teamSource: null
        },
        {
          dms: { enabled: true, allowedWakeSenders: [] },
          memberId: null,
          network: "org",
          teamSource: null
        }
      ]
    });

    const team = createTeam({
      members: [
        {
          id: "rep",
          kind: "agent",
          nodeSource: agent.source,
          runtimeName: "openclaw"
        }
      ],
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: []
        }
      ]
    });

    const plan: CompilePlan = {
      edges: [],
      memberships: [
        {
          agentSource: agent.source,
          memberId: "rep",
          teamName: team.name,
          teamSource: team.source
        }
      ],
      nodes: [
        { id: "agent", kind: "agent", runtimeName: "openclaw", slug: "rep", value: agent },
        { id: "team", kind: "team", runtimeName: null, slug: "team", value: team }
      ],
      root: team.source,
      runtimes: { openclaw: { nodeIds: ["agent"] } }
    };

    expect(() => resolvePlanMoltnetAttachments(plan)).toThrow(/incompatible Moltnet dms/);
  });
});
