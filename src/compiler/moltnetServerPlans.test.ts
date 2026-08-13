import { describe, expect, it } from "vitest";

import type { TeamNetworkServer } from "../manifest/index.js";
import { resolveMoltnetServerPlans } from "./moltnetServerPlans.js";
import type {
  CompilePlan,
  ResolvedTeamNetwork,
  ResolvedTeamNode
} from "./types.js";

const server = (port = 8787): TeamNetworkServer => ({
  auth: { mode: "none" },
  listen: { bind: "127.0.0.1", port },
  mode: "managed",
  store: { kind: "memory" }
});

const network = (
  id: string,
  roomId: string,
  owner: TeamNetworkServer | undefined
): ResolvedTeamNetwork => ({
  id,
  name: id,
  provider: "moltnet",
  rooms: [{ id: roomId, members: [] }],
  ...(owner ? { server: owner } : {})
});

const team = (
  source: string,
  name: string,
  networks: ResolvedTeamNetwork[],
  members: ResolvedTeamNode["members"] = []
): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  externalExplicit: false,
  kind: "team",
  lead: null,
  members,
  mode: "swarm",
  name,
  networks,
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source
});

const createPlan = (
  rootNetworks: ResolvedTeamNetwork[],
  childNetworks: ResolvedTeamNetwork[]
): CompilePlan => {
  const rootSource = "/org/Spawnfile";
  const childSource = "/org/child/Spawnfile";
  return {
    edges: [{ from: "root", kind: "team_member", label: "child", to: "child" }],
    nodes: [
      {
        id: "root",
        kind: "team",
        runtimeName: null,
        slug: "root",
        value: team(rootSource, "root", rootNetworks, [{
          id: "child",
          kind: "team",
          nodeSource: childSource,
          runtimeName: null
        }])
      },
      {
        id: "child",
        kind: "team",
        runtimeName: null,
        slug: "child",
        value: team(childSource, "child", childNetworks)
      }
    ],
    organizationIdentity: { agentMembers: [], externalParticipants: [] },
    root: rootSource,
    runtimes: {}
  };
};

const resolve = (plan: CompilePlan) => resolveMoltnetServerPlans(
  plan,
  plan.nodes.filter((node): node is typeof node & { value: ResolvedTeamNode } =>
    node.kind === "team"
  )
);

describe("Moltnet server-plan composition", () => {
  it("merges a nested ownerless overlay into its root-owned server", () => {
    const plan = createPlan(
      [network("pitch", "root-room", server())],
      [network("pitch", "child-room", undefined)]
    );
    if (plan.nodes[0]?.value.kind === "team" && plan.nodes[0].value.networks?.[0]) {
      plan.nodes[0].value.networks[0].name = "Tiny Football Pitch";
    }
    const plans = resolve(plan);

    expect([...plans]).toHaveLength(1);
    expect(plans.get("pitch")?.rooms.map((room) => room.id))
      .toEqual(["child-room", "root-room"]);
  });

  it("rejects an ownerless root even when a child declares the server", () => {
    const plan = createPlan(
      [network("pitch", "root-room", undefined)],
      [network("pitch", "child-room", server())]
    );

    expect(() => resolve(plan)).toThrow(/Root Moltnet network pitch must declare/u);
  });

  it("rejects an overlay without an owner", () => {
    const plan = createPlan(
      [network("root-net", "root-room", server())],
      [network("pitch", "child-room", undefined)]
    );

    expect(() => resolve(plan)).toThrow(/pitch.*at least one server owner/u);
  });

  it("does not accept an unrelated or subagent-only team as an owner", () => {
    const plan = createPlan(
      [network("root-net", "root-room", server())],
      [network("pitch", "child-room", undefined)]
    );
    plan.nodes.push({
      id: "unrelated",
      kind: "team",
      runtimeName: null,
      slug: "unrelated",
      value: team("/org/unrelated/Spawnfile", "unrelated", [
        network("pitch", "unrelated-room", server())
      ])
    });
    plan.edges.push({ from: "root", kind: "subagent", label: "helper", to: "unrelated" });

    expect(() => resolve(plan)).toThrow(/pitch.*at least one server owner/u);
  });

  it("coalesces identical owners and rejects conflicting owners", () => {
    const compatible = createPlan(
      [network("pitch", "root-room", server())],
      [network("pitch", "child-room", server())]
    );
    expect([...resolve(compatible)]).toHaveLength(1);

    const conflicting = createPlan(
      [network("pitch", "root-room", server())],
      [network("pitch", "child-room", server(8788))]
    );
    expect(() => resolve(conflicting)).toThrow(/conflicting server URL/u);
  });

  it("is byte-stable across team and network declaration order", () => {
    const first = createPlan(
      [network("beta", "root-b", server(8788)), network("alpha", "root-a", server())],
      [network("beta", "child-b", undefined), network("alpha", "child-a", undefined)]
    );
    const second = structuredClone(first);
    second.nodes.reverse();
    for (const node of second.nodes) {
      if (node.value.kind === "team") node.value.networks?.reverse();
    }

    expect(JSON.stringify([...resolve(second).values()]))
      .toBe(JSON.stringify([...resolve(first).values()]));
  });
});
