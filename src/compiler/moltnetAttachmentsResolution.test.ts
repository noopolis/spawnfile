import { describe, expect, it } from "vitest";

import { resolvePlanMoltnetAttachments } from "./moltnetResolution.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const createAgent = (): ResolvedAgentNode => ({
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
  surfaces: {
    moltnet: [
      {
        memberId: null,
        network: "org",
        rooms: {
          shared: {
            wake: "mentions"
          }
        },
        teamSource: null
      }
    ]
  },
  subagents: []
});

const createTeam = (
  name: string,
  overrides: Partial<ResolvedTeamNode>
): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  externalExplicit: false,
  kind: "team",
  lead: null,
  members: [],
  mode: "swarm",
  name,
  networks: [],
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: `/tmp/${name}/Spawnfile`,
  ...overrides
});

const createPlan = (): {
  agent: ResolvedAgentNode;
  childTeam: ResolvedTeamNode;
  parentTeam: ResolvedTeamNode;
  plan: CompilePlan;
} => {
  const agent = createAgent();
  const childTeam = createTeam("child", {
    external: ["rep"],
    externalExplicit: true,
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
        rooms: [{ id: "shared", members: ["rep"] }]
      }
    ],
    source: "/tmp/child/Spawnfile"
  });
  const parentTeam = createTeam("parent", {
    members: [
      {
        id: "child",
        kind: "team",
        nodeSource: childTeam.source,
        runtimeName: null
      }
    ],
    networks: [
      {
        id: "org",
        name: "Org",
        provider: "moltnet",
        rooms: [{ id: "shared", members: ["child"] }]
      }
    ],
    source: "/tmp/parent/Spawnfile"
  });
  const plan: CompilePlan = {
    edges: [],
    memberships: [
      {
        agentSource: agent.source,
        memberId: "rep",
        teamName: "child",
        teamSource: childTeam.source
      }
    ],
    nodes: [
      { id: "agent", kind: "agent", runtimeName: "openclaw", slug: "rep", value: agent },
      { id: "child", kind: "team", runtimeName: null, slug: "child", value: childTeam },
      { id: "parent", kind: "team", runtimeName: null, slug: "parent", value: parentTeam }
    ],
    root: parentTeam.source,
    runtimes: { openclaw: { nodeIds: ["agent"] } }
  };

  return { agent, childTeam, parentTeam, plan };
};

describe("moltnet attachment resolution", () => {
  it("merges synthesized representative rooms with authored direct room policy", () => {
    const { agent, childTeam, parentTeam, plan } = createPlan();

    resolvePlanMoltnetAttachments(plan);

    expect(agent.surfaces?.moltnet).toEqual([
      {
        contextRooms: {
          [childTeam.source]: ["shared"],
          [parentTeam.source]: ["shared"]
        },
        memberId: "rep",
        network: "org",
        rooms: {
          shared: {
            wake: "mentions"
          }
        },
        teamSource: childTeam.source
      }
    ]);
  });

  it("preserves authored room member slots during attachment resolution", () => {
    const { parentTeam, plan } = createPlan();

    resolvePlanMoltnetAttachments(plan);

    expect(parentTeam.networks?.[0]?.rooms[0]?.members).toEqual(["child"]);
    expect(plan.moltnetRoomMemberships?.map((row) => row.concreteMemberId)).toEqual([
      "rep",
      "rep"
    ]);
  });
});
