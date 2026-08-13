import { describe, expect, it, vi } from "vitest";

import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "../types.js";

const state = vi.hoisted(() => ({ plan: undefined as unknown }));

vi.mock("../buildCompilePlan.js", () => ({
  buildCompilePlan: vi.fn(async () => state.plan)
}));
vi.mock("../moltnetRoomMemberships.js", () => ({
  resolveMoltnetRoomMemberships: vi.fn(() => [])
}));

import { buildOrganizationView } from "./buildOrganizationView.js";

const agent = (id: string, name = "assistant"): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name,
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "pi", options: {} },
  secrets: [],
  skills: [],
  source: `/org/${id}/Spawnfile`,
  subagents: []
});

const team = (id: string): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  kind: "team",
  lead: null,
  members: [],
  mode: "swarm",
  name: id,
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: `/org/${id}/Spawnfile`
});

const plan = (): CompilePlan => {
  const root = team("root");
  const nested = team("nested");
  const alpha = agent("alpha");
  const beta = agent("beta");
  root.networks = [
    {
      id: "shared",
      name: "Managed Shared",
      provider: "moltnet",
      rooms: [{ id: "general", members: [], visibility: "public", write_policy: "members" }],
      server: {
        auth: {
          agent_registration: "open",
          mode: "bearer",
          public_read: true
        },
        console: { analytics: { provider: "memory" } },
        debug_events: true,
        direct_messages: true,
        human_ingress: true,
        listen: { bind: "127.0.0.1", port: 8787 },
        mode: "managed",
        store: { kind: "memory" }
      }
    }
  ] as never;
  nested.networks = [{
    id: "shared",
    name: "External Shared",
    provider: "moltnet",
    rooms: [{ id: "quiet", members: [] }],
    server: { auth: { mode: "none" }, mode: "external", url: "https://network.example" }
  }];
  return {
    edges: [
      { from: "team:root", kind: "team_member", label: "alpha", to: "agent:alpha" },
      { from: "team:root", kind: "team_member", label: "beta", to: "agent:beta" },
      { from: "team:root", kind: "team_member", label: "nested", to: "team:nested" }
    ],
    moltnetRoomMemberships: [],
    nodes: [
      { id: "team:root", kind: "team", runtimeName: null, slug: "root", value: root },
      { id: "agent:alpha", kind: "agent", runtimeName: "pi", slug: "alpha", value: alpha },
      { id: "agent:beta", kind: "agent", runtimeName: "pi", slug: "beta", value: beta },
      { id: "team:nested", kind: "team", runtimeName: null, slug: "nested", value: nested }
    ],
    root: root.source,
    runtimes: { pi: { nodeIds: ["agent:alpha", "agent:beta"] } }
  };
};

describe("organization view branch behavior", () => {
  it("disambiguates repeated names and combines same-provider network declarations", async () => {
    state.plan = plan();
    const view = await buildOrganizationView("/org/root/Spawnfile");

    const agents = view.root.children.filter((child) => child.node.kind === "agent");
    expect(agents.map((child) => child.node.displayName)).toEqual([
      "assistant [agent:alpha]",
      "assistant [agent:beta]"
    ]);
    expect(view.networks).toHaveLength(1);
    expect(view.networks[0]).toMatchObject({
      consoleAnalytics: "memory",
      declarations: [{ name: "Managed Shared" }, { name: "External Shared" }],
      httpEnabled: true,
      name: "Managed Shared"
    });
    expect(view.root.networks?.[0]?.rooms[0]).toMatchObject({
      visibility: "public",
      writePolicy: "members"
    });
  });

  it("rejects a cycle, a missing child, and a plan without its root node", async () => {
    const cyclic = plan();
    cyclic.edges = [{ from: "team:root", kind: "team_member", label: "self", to: "team:root" }];
    state.plan = cyclic;
    await expect(buildOrganizationView("/org/root/Spawnfile")).rejects.toThrow(/Cycle detected/);

    const missing = plan();
    missing.edges = [{ from: "team:root", kind: "team_member", label: "missing", to: "agent:missing" }];
    state.plan = missing;
    await expect(buildOrganizationView("/org/root/Spawnfile")).rejects.toThrow(/Unable to find view node/);

    const rootless = plan();
    rootless.root = "/org/absent/Spawnfile";
    state.plan = rootless;
    await expect(buildOrganizationView("/org/root/Spawnfile")).rejects.toThrow(/Unable to find root view node/);
  });
});
