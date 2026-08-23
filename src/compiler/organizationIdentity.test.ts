import { describe, expect, it } from "vitest";
import {
  resolveMoltnetExternalParticipantIntents,
  resolveOrganizationIdentity,
  validateB31MoltnetAuth
} from "./organizationIdentity.js";
import { resolveMoltnetRoomMemberships } from "./moltnetRoomMemberships.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const plan = (slot = "red"): CompilePlan => ({
  edges: [{ from: "root", kind: "team_member", label: slot, to: "agent" }], root: "/org/Spawnfile.yaml",
  nodes: [
    { id: "root", kind: "team", runtimeName: null, slug: "root", value: { kind: "team", source: "/org/Spawnfile.yaml", name: "tiny-football", description: "", external: [], mode: "swarm", lead: null, members: [{ id: slot, kind: "agent", nodeSource: "/org/red.yaml", runtimeName: "pi" }], shared: { env: {}, mcpServers: [], secrets: [], skills: [] }, networks: [{ id: "pitch", name: "pitch", provider: "moltnet", rooms: [], server: undefined }], externalParticipants: [{ id: "world", kind: "service", surfaces: { moltnet: [{ network: "pitch", auth: { token_id: "world" }, dms: { enabled: true } }] } }] } as never },
    { id: "agent", kind: "agent", runtimeName: "pi", slug: "agent", value: { kind: "agent", source: "/org/red.yaml", name: "red", surfaces: { moltnet: [{ network: "pitch", dms: { enabled: true } }] } } as never }
  ], runtimes: {}
});

const createB31Network = (id: string, actors = ["red", "world"]) => ({
  id,
  name: id,
  provider: "moltnet" as const,
  rooms: [],
  server: {
    auth: {
      client: { token_id: "operator" },
      mode: "bearer" as const,
      tokens: [
        { id: "operator", scopes: ["admin", "observe", "write"], secret: `${id.toUpperCase()}_OPERATOR` },
        ...actors.map((actor) => ({ agents: [actor], id: actor, scopes: ["attach", "write"], secret: `${id.toUpperCase()}_${actor.toUpperCase()}` }))
      ]
    },
    direct_messages: true,
    listen: { bind: "127.0.0.1", port: id === "beta" ? 8788 : 8787 },
    mode: "managed" as const,
    store: { kind: "memory" as const }
  }
});

const createB31Plan = (networkIds = ["pitch"]): CompilePlan => {
  const current = plan();
  const root = current.nodes[0]?.value as ResolvedTeamNode;
  const red = current.nodes[1]?.value as ResolvedAgentNode;
  root.networks = networkIds.map((id) => createB31Network(id)) as never;
  root.externalParticipants = [{
    id: "world",
    kind: "service",
    surfaces: { moltnet: networkIds.map((network) => ({ auth: { token_id: "world" }, dms: { enabled: true }, network })) }
  }];
  red.surfaces = { moltnet: networkIds.map((network) => ({
    auth: { tokenId: "red" }, dms: { enabled: true }, memberId: null, network, teamSource: null
  })) };
  current.organizationIdentity = resolveOrganizationIdentity(current);
  return current;
};

const rootOf = (current: CompilePlan): ResolvedTeamNode =>
  current.nodes.find((node) => node.kind === "team")?.value as ResolvedTeamNode;
const redOf = (current: CompilePlan): ResolvedAgentNode =>
  current.nodes.find((node) => node.kind === "agent")?.value as ResolvedAgentNode;
describe("organization identity", () => {
  it("uses authored slots and freezes the result", () => {
    const current = plan();
    const resolved = resolveOrganizationIdentity(current);
    expect(resolved?.agentMembers[0]).toMatchObject({ memberId: "red", principalId: "agent:red" });
    expect([
      resolved,
      resolved?.agentMembers,
      resolved?.agentMembers[0],
      resolved?.externalParticipants,
      resolved?.externalParticipants[0]
    ].every(Object.isFrozen)).toBe(true);
    rootOf(current).members[0].id = "changed-after-resolution";
    expect(resolved?.agentMembers[0].memberId).toBe("red");
  });

  it("is source, name, runtime, and edge-order independent", () => {
    const first = plan();
    const root = rootOf(first);
    root.members.push({ id: "blue", kind: "agent", nodeSource: "/org/blue.yaml", runtimeName: "pi" });
    first.edges.unshift({ from: "root", kind: "team_member", label: "blue", to: "blue" });
    first.nodes.push({ id: "blue", kind: "agent", runtimeName: "pi", slug: "z", value: { kind: "agent", name: "display-blue", source: "/org/blue.yaml" } as never });

    const second = structuredClone(first);
    second.root = "/different/absolute/root/Spawnfile.yaml";
    rootOf(second).source = second.root;
    const secondRed = second.nodes.find((node) => node.id === "agent");
    const secondBlue = second.nodes.find((node) => node.id === "blue");
    if (!secondRed || !secondBlue) throw new Error("expected agents");
    secondRed.value.source = "/different/red.yaml";
    secondBlue.value.source = "/different/blue.yaml";
    rootOf(second).members.find((member) => member.id === "red")!.nodeSource = secondRed.value.source;
    rootOf(second).members.find((member) => member.id === "blue")!.nodeSource = secondBlue.value.source;
    secondRed.runtimeName = "other-runtime";
    (secondRed.value as ResolvedAgentNode).name = "other-display-name";
    second.edges.reverse();

    expect(resolveOrganizationIdentity(first)?.agentMembers.map((member) => member.memberId))
      .toEqual(["blue", "red"]);
    expect(resolveOrganizationIdentity(second)).toEqual(resolveOrganizationIdentity(first));
  });
  it("rejects invalid authored slots and derives explicit same-network peers", () => {
    for (const slot of ["Red", "réd", "red_blue", "red.blue", "red/blue", "red%20blue"]) {
      expect.soft(() => resolveOrganizationIdentity(plan(slot)), slot).toThrow(/organization member slot/u);
    }
    const current = plan();
    current.organizationIdentity = resolveOrganizationIdentity(current);
    expect(resolveMoltnetExternalParticipantIntents(current)[0].directMessagePeers).toEqual(["red"]);
  });

  it("rejects root-only violations, aliases, and cycles at their graph boundary", () => {
    const nestedDeclaration = plan();
    nestedDeclaration.nodes.push({ id: "nested", kind: "team", runtimeName: null, slug: "nested", value: {
      ...rootOf(nestedDeclaration), source: "/org/nested.yaml"
    } });
    rootOf(nestedDeclaration).externalParticipants = undefined;
    expect(() => resolveOrganizationIdentity(nestedDeclaration)).toThrow(/root team/u);

    const agentAlias = plan();
    rootOf(agentAlias).members.push({ id: "blue", kind: "agent", nodeSource: redOf(agentAlias).source, runtimeName: "pi" });
    agentAlias.edges.push({ from: "root", kind: "team_member", label: "blue", to: "agent" });
    expect(() => resolveOrganizationIdentity(agentAlias)).toThrow(/multiple organization paths/u);

    const teamAlias = plan();
    const aliasRoot = rootOf(teamAlias);
    const child = { ...aliasRoot, externalParticipants: undefined, members: [aliasRoot.members[0]], name: "child", source: "/org/child.yaml" };
    aliasRoot.members = ["alpha", "beta"].map((id) => ({ id, kind: "team" as const, nodeSource: child.source, runtimeName: null }));
    teamAlias.nodes.splice(1, 0, { id: "child", kind: "team", runtimeName: null, slug: "child", value: child });
    teamAlias.edges = [
      { from: "root", kind: "team_member", label: "alpha", to: "child" },
      { from: "root", kind: "team_member", label: "beta", to: "child" },
      { from: "child", kind: "team_member", label: "red", to: "agent" }
    ];
    expect(() => resolveOrganizationIdentity(teamAlias)).toThrow(/team is reached through multiple/u);

    const cycle = plan();
    const cycleRoot = rootOf(cycle);
    const cycleChild = { ...cycleRoot, externalParticipants: undefined, members: [{ id: "root", kind: "team" as const, nodeSource: cycleRoot.source, runtimeName: null }], name: "child", source: "/org/cycle.yaml" };
    cycleRoot.members = [{ id: "child", kind: "team", nodeSource: cycleChild.source, runtimeName: null }];
    cycle.nodes = [cycle.nodes[0], { id: "child", kind: "team", runtimeName: null, slug: "child", value: cycleChild }];
    cycle.edges = [
      { from: "root", kind: "team_member", label: "child", to: "child" },
      { from: "child", kind: "team_member", label: "root", to: "root" }
    ];
    expect(() => resolveOrganizationIdentity(cycle)).toThrow(/cycle/u);
  });

  it("rejects member, participant, depth, and byte bounds", () => {
    const chain = (segments: string[]): CompilePlan => {
      const current = plan();
      const root = rootOf(current);
      const agent = current.nodes[1];
      current.nodes = [current.nodes[0]];
      current.edges = [];
      let parent = current.nodes[0];
      segments.forEach((segment, index) => {
        const last = index === segments.length - 1;
        const child = last ? agent : {
          id: `team-${index}`, kind: "team" as const, runtimeName: null, slug: `team-${index}`,
          value: { ...root, externalParticipants: undefined, members: [], name: `team-${index}`, source: `/org/team-${index}.yaml` }
        };
        (parent.value as ResolvedTeamNode).members = [{ id: segment, kind: child.kind, nodeSource: child.value.source, runtimeName: child.runtimeName }];
        current.edges.push({ from: parent.id, kind: "team_member", label: segment, to: child.id });
        current.nodes.push(child);
        parent = child;
      });
      return current;
    };
    expect(() => resolveOrganizationIdentity(chain(Array.from({ length: 9 }, (_, index) => `a${index}`))))
      .toThrow(/depth/u);
    expect(() => resolveOrganizationIdentity(chain(Array.from({ length: 5 }, () => "a".repeat(63)))))
      .toThrow(/invalid organization member id/u);

    const wide = plan();
    const wideRoot = rootOf(wide);
    wideRoot.members = [];
    wide.nodes = [wide.nodes[0]];
    wide.edges = [];
    for (let index = 0; index < 129; index += 1) {
      const id = `a${String(index).padStart(3, "0")}`;
      const source = `/org/${id}.yaml`;
      wideRoot.members.push({ id, kind: "agent", nodeSource: source, runtimeName: "pi" });
      wide.nodes.push({ id, kind: "agent", runtimeName: "pi", slug: id, value: { kind: "agent", name: id, source } as never });
      wide.edges.push({ from: "root", kind: "team_member", label: id, to: id });
    }
    expect(() => resolveOrganizationIdentity(wide)).toThrow(/too many agent members/u);

    const participants = plan();
    rootOf(participants).externalParticipants = Array.from({ length: 33 }, (_, index) => ({
      id: `w${index}`, kind: "service" as const,
      surfaces: { moltnet: [{ auth: { token_id: "world" }, dms: { enabled: true as const }, network: "pitch" }] }
    }));
    expect(() => resolveOrganizationIdentity(participants)).toThrow(/too many external/u);
    const collision = plan();
    rootOf(collision).externalParticipants![0].id = "red";
    expect(() => resolveOrganizationIdentity(collision)).toThrow(/collision/u);
    const duplicate = plan();
    rootOf(duplicate).externalParticipants!.push(structuredClone(rootOf(duplicate).externalParticipants![0]));
    expect(() => resolveOrganizationIdentity(duplicate)).toThrow(/collision/u);
  });

  it("rejects missing and extra organization graph cardinality", () => {
    expect(resolveOrganizationIdentity(plan())?.agentMembers).toHaveLength(1);

    const extra = plan();
    extra.nodes.push({
      id: "extra",
      kind: "agent",
      runtimeName: "pi",
      slug: "extra",
      value: { kind: "agent", name: "extra", source: "/org/extra.yaml" } as never
    });
    extra.nodes.push({
      id: "detached",
      kind: "team",
      runtimeName: null,
      slug: "detached",
      value: {
        ...rootOf(extra),
        externalParticipants: undefined,
        members: [{
          id: "extra",
          kind: "agent",
          nodeSource: "/org/extra.yaml",
          runtimeName: "pi"
        }],
        name: "detached",
        source: "/org/detached.yaml"
      }
    });
    extra.edges.push({
      from: "detached",
      kind: "team_member",
      label: "extra",
      to: "extra"
    });
    expect.soft(() => resolveOrganizationIdentity(extra)).toThrow(/cardinality|unreachable/u);

    const missing = plan();
    const root = missing.nodes[0]?.value as ResolvedTeamNode;
    root.members.push({ id: "blue", kind: "agent", nodeSource: "/org/blue.yaml", runtimeName: "pi" });
    expect.soft(() => resolveOrganizationIdentity(missing)).toThrow(/cardinality|edge/u);
  });

  it("keeps subagent-only nodes outside organization identity and Moltnet authority", () => {
    const current = createB31Plan();
    const root = rootOf(current);
    root.networks![0].rooms = [{ id: "field", members: ["red"] }];
    current.nodes.push({
      id: "helper",
      kind: "agent",
      runtimeName: "pi",
      slug: "helper",
      value: {
        kind: "agent",
        name: "helper",
        source: "/org/helper.yaml",
        surfaces: {
          moltnet: [{
            auth: { tokenId: "red" },
            dms: { enabled: true },
            memberId: null,
            network: "pitch",
            teamSource: null
          }]
        }
      } as never
    });
    current.edges.push({ from: "agent", kind: "subagent", label: "helper", to: "helper" });
    current.organizationIdentity = resolveOrganizationIdentity(current);

    expect(current.organizationIdentity?.agentMembers.map((member) => member.memberId))
      .toEqual(["red"]);
    expect(resolveMoltnetRoomMemberships(current).map((membership) =>
      membership.concreteMemberId
    )).toEqual(["red"]);
    expect(resolveMoltnetExternalParticipantIntents(current)[0]?.directMessagePeers)
      .toEqual(["red"]);
    expect(() => validateB31MoltnetAuth(current)).not.toThrow();
  });

  it("allows required actor and operator token ids to repeat on distinct networks", () => {
    const current = createB31Plan(["alpha", "beta"]);

    expect(resolveMoltnetExternalParticipantIntents(current)).toHaveLength(2);
    expect(() => validateB31MoltnetAuth(current)).not.toThrow();
  });

  it("allows an actor-bound external service to observe only its filtered DM topology", () => {
    const current = createB31Plan();
    const network = rootOf(current).networks?.[0];
    if (network?.server?.mode !== "managed") throw new Error("expected managed server");
    const world = network.server.auth.tokens?.find((token) => token.id === "world");
    if (!world) throw new Error("expected world token");
    world.scopes = ["attach", "observe", "write"];

    expect(() => validateB31MoltnetAuth(current)).not.toThrow();
    expect(resolveMoltnetExternalParticipantIntents(current)[0]?.tokenEnv)
      .toBe("PITCH_WORLD");
  });

  it("rejects hostile operator, actor, token, and environment declarations", () => {
    const server = (current: CompilePlan) => {
      const value = rootOf(current).networks?.[0]?.server;
      if (!value || value.mode !== "managed") throw new Error("expected managed server");
      return value;
    };
    const token = (current: CompilePlan, id: string) =>
      server(current).auth.tokens?.find((entry) => entry.id === id)!;
    const cases: Array<[string, (current: CompilePlan) => void]> = [
      ["unmanaged", (current) => { rootOf(current).networks![0].server = { auth: { mode: "none" }, mode: "external", url: "https://example.test" }; }],
      ["non-bearer", (current) => { server(current).auth.mode = "open"; }],
      ["DM-disabled", (current) => { server(current).direct_messages = false; }],
      ["non-exact client", (current) => { server(current).auth.client = { token_id: "operator", token_env: "FALLBACK" }; }],
      ["operator agents", (current) => { token(current, "operator").agents = []; }],
      ["operator scopes", (current) => { token(current, "operator").scopes = ["observe", "admin", "write"]; }],
      ["missing actor selection", (current) => { redOf(current).surfaces!.moltnet![0].auth = undefined; }],
      ["operator fallback", (current) => { redOf(current).surfaces!.moltnet![0].auth = { tokenId: "operator" }; }],
      ["unknown actor", (current) => { redOf(current).surfaces!.moltnet![0].auth = { tokenId: "missing" }; }],
      ["wrong actor scopes", (current) => { token(current, "red").scopes = ["attach", "write", "admin"]; }],
      ["wrong actor binding", (current) => { token(current, "red").agents = ["blue"]; }],
      ["shared actor selection", (current) => { rootOf(current).externalParticipants![0].surfaces.moltnet[0].auth.token_id = "red"; }],
      ["duplicate env", (current) => { token(current, "world").secret = token(current, "red").secret; }],
      ["invalid env", (current) => { token(current, "world").secret = "actual-secret-value"; }],
      ["invalid token id", (current) => { token(current, "world").id = "World"; }],
      ["unused token", (current) => { server(current).auth.tokens!.push({ agents: ["nobody"], id: "nobody", scopes: ["attach", "write"], secret: "NOBODY_ENV" }); }]
    ];
    for (const [label, mutate] of cases) {
      const current = createB31Plan();
      expect(() => validateB31MoltnetAuth(current), `${label} setup`).not.toThrow();
      mutate(current);
      expect.soft(() => validateB31MoltnetAuth(current), label).toThrow();
    }
  });

  it("derives only explicit same-network DMs, including nested canonical peers", () => {
    const filtered = createB31Plan();
    const root = rootOf(filtered);
    for (const [id, network, enabled] of [["blue", "pitch", false], ["green", "other", true]] as const) {
      const source = `/org/${id}.yaml`;
      root.members.push({ id, kind: "agent", nodeSource: source, runtimeName: "pi" });
      filtered.edges.push({ from: "root", kind: "team_member", label: id, to: id });
      filtered.nodes.push({ id, kind: "agent", runtimeName: "pi", slug: id, value: {
        kind: "agent", name: id, source,
        surfaces: { moltnet: [{ dms: { enabled }, memberId: null, network, teamSource: null }] }
      } as never });
    }
    filtered.organizationIdentity = resolveOrganizationIdentity(filtered);
    expect(resolveMoltnetExternalParticipantIntents(filtered)[0].directMessagePeers).toEqual(["red"]);

    const nested = createB31Plan();
    const nestedRoot = rootOf(nested);
    const redNode = nested.nodes.find((node) => node.kind === "agent")!;
    const child: ResolvedTeamNode = { ...nestedRoot, externalParticipants: undefined, members: [nestedRoot.members[0]], name: "field", source: "/org/field.yaml" };
    nestedRoot.members = [{ id: "field", kind: "team", nodeSource: child.source, runtimeName: null }];
    nested.nodes.splice(1, 0, { id: "field", kind: "team", runtimeName: null, slug: "field", value: child });
    nested.edges = [
      { from: "root", kind: "team_member", label: "field", to: "field" },
      { from: "field", kind: "team_member", label: "red", to: redNode.id }
    ];
    nested.organizationIdentity = resolveOrganizationIdentity(nested);
    expect(resolveMoltnetExternalParticipantIntents(nested)[0].directMessagePeers).toEqual(["field.red"]);

    const duplicate = createB31Plan();
    redOf(duplicate).surfaces!.moltnet!.push(structuredClone(redOf(duplicate).surfaces!.moltnet![0]));
    expect(() => resolveMoltnetExternalParticipantIntents(duplicate)).toThrow(/duplicate eligible/u);
    const empty = createB31Plan();
    redOf(empty).surfaces!.moltnet![0].dms = { enabled: false };
    rootOf(empty).networks![0].rooms = [{ id: "field", members: ["red"] }];
    expect(() => resolveMoltnetExternalParticipantIntents(empty)).toThrow(/no eligible/u);
  });

  it("derives the no-external agent graph while leaving external auth inactive", () => {
    const current = plan();
    rootOf(current).externalParticipants = undefined;
    current.nodes.push({ id: "legacy-extra", kind: "agent", runtimeName: "pi", slug: "legacy-extra", value: { kind: "agent", name: "legacy-extra", source: "/legacy/extra" } as never });
    current.organizationIdentity = resolveOrganizationIdentity(current);
    expect(current.organizationIdentity).toMatchObject({
      agentMembers: [{ memberId: "red", principalId: "agent:red" }], externalParticipants: [],
    });
    expect(resolveMoltnetExternalParticipantIntents(current)).toEqual([]);
    expect(() => validateB31MoltnetAuth(current)).not.toThrow();
  });
});
