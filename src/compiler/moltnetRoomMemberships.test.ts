import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { buildCompilePlan } from "./buildCompilePlan.js";
import { generateMoltnetArtifacts } from "./moltnetArtifacts.js";
import {
  listConcreteMoltnetRoomMemberIds,
  resolveMoltnetRoomMemberships
} from "./moltnetRoomMemberships.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import type { TeamNetworkServer } from "../manifest/index.js";

const temporaryDirectories: string[] = [];

const createManagedServer = (): Extract<TeamNetworkServer, { mode: "managed" }> => ({
  auth: { mode: "none" },
  listen: { bind: "127.0.0.1", port: 8787 },
  mode: "managed",
  store: { kind: "memory" }
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

const agent = (
  id: string,
  surfaces?: ResolvedAgentNode["surfaces"]
): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name: `${id}-agent`,
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options: {} },
  secrets: [],
  skills: [],
  source: `/tmp/${id}/Spawnfile`,
  surfaces,
  subagents: []
});

const team = (
  id: string,
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
  name: id,
  networks: [],
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: `/tmp/${id}/Spawnfile`,
  ...overrides
});

const node = (
  value: ResolvedAgentNode | ResolvedTeamNode,
  id = value.name
): CompilePlan["nodes"][number] => ({
  id,
  kind: value.kind,
  runtimeName: value.kind === "agent" ? value.runtime.name : null,
  slug: id,
  value
});

const plan = (
  nodes: CompilePlan["nodes"],
  root = nodes[0]?.value.source ?? "/tmp/root/Spawnfile"
): CompilePlan => ({
  edges: [],
  nodes,
  root,
  runtimes: { openclaw: { nodeIds: nodes.filter((entry) => entry.kind === "agent").map((entry) => entry.id) } }
});

describe("moltnetRoomMemberships", () => {
  it("returns no rows when a plan has no Moltnet networks", () => {
    const solo = agent("solo");

    expect(resolveMoltnetRoomMemberships(plan([node(solo)]))).toEqual([]);
  });

  it("resolves direct members with authored room policy", () => {
    const lead = agent("lead", {
      moltnet: [
        {
          memberId: null,
          network: "org",
          rooms: { general: { read: "all", reply: "auto" } },
          teamSource: null
        }
      ]
    });
    const org = team("org-team", {
      members: [{ id: "lead", kind: "agent", nodeSource: lead.source, runtimeName: "openclaw" }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "general", members: ["lead"] }] }]
    });

    expect(resolveMoltnetRoomMemberships(plan([node(lead), node(org)]))).toEqual([
      expect.objectContaining({
        agentName: "lead-agent",
        agentSource: lead.source,
        concreteMemberId: "lead",
        declaredSlot: "lead",
        declaringTeamSource: org.source,
        directTeamSource: org.source,
        networkId: "org",
        policy: { read: "all", reply: "auto" },
        roomId: "general"
      })
    ]);
  });

  it("resolves nested representatives while omitting synthesized policy", () => {
    const rep = agent("rep", {
      moltnet: [
        {
          memberId: null,
          network: "org",
          rooms: { general: { read: "mentions" } },
          teamSource: null
        }
      ]
    });
    const child = team("child", {
      external: ["rep"],
      externalExplicit: true,
      members: [{ id: "rep", kind: "agent", nodeSource: rep.source, runtimeName: "openclaw" }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "general", members: ["rep"] }] }]
    });
    const parent = team("parent", {
      members: [{ id: "child", kind: "team", nodeSource: child.source, runtimeName: null }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "general", members: ["child"] }] }]
    });

    const rows = resolveMoltnetRoomMemberships(plan([node(rep), node(child), node(parent)]));
    const parentRow = rows.find((row) => row.declaringTeamSource === parent.source);

    expect(parentRow).toMatchObject({
      concreteMemberId: "rep",
      declaredSlot: "child",
      directTeamSource: child.source,
      representedSlot: "child",
      representedTeamSource: child.source,
      representativePath: ["child", "rep"]
    });
    expect(parentRow).not.toHaveProperty("policy");
    expect(rows.find((row) => row.declaringTeamSource === child.source)?.policy).toEqual({
      read: "mentions"
    });
  });

  it("records deep representative paths", () => {
    const rep = agent("rep");
    const child = team("child", {
      external: ["rep"],
      externalExplicit: true,
      members: [{ id: "rep", kind: "agent", nodeSource: rep.source, runtimeName: "openclaw" }]
    });
    const middle = team("middle", {
      external: ["child"],
      externalExplicit: true,
      members: [{ id: "child", kind: "team", nodeSource: child.source, runtimeName: null }]
    });
    const parent = team("parent", {
      members: [{ id: "middle", kind: "team", nodeSource: middle.source, runtimeName: null }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "general", members: ["middle"] }] }]
    });

    expect(resolveMoltnetRoomMemberships(plan([node(rep), node(child), node(middle), node(parent)]))[0])
      .toMatchObject({
        concreteMemberId: "rep",
        directTeamSource: child.source,
        representedTeamSource: middle.source,
        representativePath: ["middle", "child", "rep"]
      });
  });

  it("expands multiple representatives from swarm teams", () => {
    const first = agent("first");
    const second = agent("second");
    const child = team("child", {
      members: [
        { id: "first", kind: "agent", nodeSource: first.source, runtimeName: "openclaw" },
        { id: "second", kind: "agent", nodeSource: second.source, runtimeName: "openclaw" }
      ]
    });
    const parent = team("parent", {
      members: [{ id: "child", kind: "team", nodeSource: child.source, runtimeName: null }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "room", members: ["child"] }] }]
    });

    expect(resolveMoltnetRoomMemberships(plan([node(first), node(second), node(child), node(parent)]))
      .map((row) => row.concreteMemberId)).toEqual(["first", "second"]);
  });

  it("keeps reused network ids scoped to declaring teams", () => {
    const first = agent("first");
    const second = agent("second");
    const firstTeam = team("first-team", {
      members: [{ id: "first", kind: "agent", nodeSource: first.source, runtimeName: "openclaw" }],
      networks: [{ id: "shared", name: "Shared", provider: "moltnet", rooms: [{ id: "room", members: ["first"] }] }]
    });
    const secondTeam = team("second-team", {
      members: [{ id: "second", kind: "agent", nodeSource: second.source, runtimeName: "openclaw" }],
      networks: [{ id: "shared", name: "Shared", provider: "moltnet", rooms: [{ id: "room", members: ["second"] }] }]
    });

    expect(resolveMoltnetRoomMemberships(plan([node(first), node(second), node(firstTeam), node(secondTeam)]))
      .map((row) => `${row.declaringTeamName}:${row.networkId}:${row.concreteMemberId}`))
      .toEqual(["first-team:shared:first", "second-team:shared:second"]);
  });

  it("omits policy when direct attachments do not author a matching room policy", () => {
    const lead = agent("lead", {
      moltnet: [
        {
          memberId: null,
          network: "other",
          rooms: { room: { read: "all" } },
          teamSource: null
        },
        {
          memberId: "other-member",
          network: "org",
          rooms: { room: { reply: "auto" } },
          teamSource: null
        },
        {
          memberId: null,
          network: "org",
          rooms: { other_room: { read: "mentions" } },
          teamSource: "/tmp/other-team/Spawnfile"
        }
      ]
    });
    const org = team("org-team", {
      members: [{ id: "lead", kind: "agent", nodeSource: lead.source, runtimeName: "openclaw" }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "room", members: ["lead"] }] }]
    });

    expect(resolveMoltnetRoomMemberships(plan([node(lead), node(org)]))[0])
      .not.toHaveProperty("policy");
  });

  it("lists concrete member ids from stored rows and direct authored room slots", () => {
    const lead = agent("lead");
    const org = team("org-team", {
      members: [{ id: "lead", kind: "agent", nodeSource: lead.source, runtimeName: "openclaw" }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "room", members: ["lead"] }] }]
    });
    const concretePlan = plan([node(lead), node(org)]);
    const room = org.networks?.[0]?.rooms[0];
    if (!room) {
      throw new Error("expected room");
    }

    expect(listConcreteMoltnetRoomMemberIds(concretePlan, org, "org", room)).toEqual(["lead"]);
    concretePlan.moltnetRoomMemberships = [
      {
        agentName: lead.name,
        agentSource: lead.source,
        concreteMemberId: "stored",
        declaredSlot: "lead",
        declaringTeamName: org.name,
        declaringTeamSource: org.source,
        directTeamName: org.name,
        directTeamSource: org.source,
        networkId: "org",
        roomId: "room"
      }
    ];
    expect(listConcreteMoltnetRoomMemberIds(concretePlan, org, "org", room)).toEqual(["stored"]);
  });

  it("rejects concrete member listing when a nested team cannot be found", () => {
    const org = team("org-team", {
      members: [{ id: "missing", kind: "team", nodeSource: "/tmp/missing/Spawnfile", runtimeName: null }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "room", members: ["missing"] }] }]
    });
    const concretePlan = plan([node(org)]);
    const room = org.networks?.[0]?.rooms[0];
    if (!room) {
      throw new Error("expected room");
    }

    expect(() => listConcreteMoltnetRoomMemberIds(concretePlan, org, "org", room))
      .toThrow(/Unable to find team node/);
  });

  it("buildCompilePlan preserves authored nested-team room members", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-rooms-"));
    temporaryDirectories.push(directory);
    await ensureDirectory(path.join(directory, "child", "agents", "rep"));
    await writeUtf8File(path.join(directory, "child", "agents", "rep", "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: rep",
      "runtime: openclaw",
      ""
    ].join("\n"));
    await writeUtf8File(path.join(directory, "child", "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: child",
      "members:",
      "  - id: rep",
      "    ref: ./agents/rep",
      "mode: hierarchical",
      "lead: rep",
      "external: [rep]",
      ""
    ].join("\n"));
    await writeUtf8File(path.join(directory, "Spawnfile"), [
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: parent",
      "members:",
      "  - id: child",
      "    ref: ./child",
      "mode: swarm",
      "networks:",
      "  - id: org",
      "    provider: moltnet",
      "    server:",
      "      mode: managed",
      "      listen:",
      "        bind: 127.0.0.1",
      "        port: 8787",
      "      store:",
      "        kind: memory",
      "      auth:",
      "        mode: none",
      "    rooms:",
      "      - id: general",
      "        members: [child]",
      ""
    ].join("\n"));

    const built = await buildCompilePlan(directory);
    const parent = built.nodes.find((entry) => entry.value.name === "parent")?.value;
    if (!parent || parent.kind !== "team") {
      throw new Error("expected parent team");
    }

    expect(parent.networks?.[0]?.rooms[0]?.members).toEqual(["child"]);
    expect(built.moltnetRoomMemberships?.map((row) => row.concreteMemberId)).toEqual(["rep"]);
  });

  it("moltnetArtifacts uses concrete memberships without rewriting authored declarations", async () => {
    const rep = agent("rep");
    const parent = team("parent", {
      members: [{ id: "child", kind: "team", nodeSource: "/tmp/child/Spawnfile", runtimeName: null }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [{ id: "room", members: ["child"] }], server: createManagedServer() }]
    });
    const artifactPlan = plan([node(rep), node(parent)]);
    artifactPlan.moltnetRoomMemberships = [
      {
        agentName: rep.name,
        agentSource: rep.source,
        concreteMemberId: "rep",
        declaredSlot: "child",
        declaringTeamName: parent.name,
        declaringTeamSource: parent.source,
        directTeamName: "child",
        directTeamSource: "/tmp/child/Spawnfile",
        networkId: "org",
        representedSlot: "child",
        representedTeamName: "child",
        representedTeamSource: "/tmp/child/Spawnfile",
        representativePath: ["child", "rep"],
        roomId: "room"
      }
    ];

    const artifacts = await generateMoltnetArtifacts(artifactPlan);

    expect(artifacts?.serverPlans[0]?.rooms[0]?.members).toEqual(["rep"]);
    expect(parent.networks?.[0]?.rooms[0]?.members).toEqual(["child"]);
  });
});
