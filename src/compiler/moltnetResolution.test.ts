import { describe, expect, it } from "vitest";

import {
  resolveTeamRepresentatives,
  resolveMoltnetAttachments,
  resolvePlanMoltnetAttachments
} from "./moltnetResolution.js";
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

describe("moltnetResolution", () => {
  it("rejects representative cycles", () => {
    const firstTeam = createTeam({
      external: ["second"],
      externalExplicit: true,
      members: [
        {
          id: "second",
          kind: "team",
          nodeSource: "/tmp/second/Spawnfile",
          runtimeName: null
        }
      ],
      source: "/tmp/first/Spawnfile"
    });
    const secondTeam = createTeam({
      external: ["first"],
      externalExplicit: true,
      members: [
        {
          id: "first",
          kind: "team",
          nodeSource: "/tmp/first/Spawnfile",
          runtimeName: null
        }
      ],
      source: "/tmp/second/Spawnfile"
    });
    const plan: CompilePlan = {
      edges: [],
      nodes: [
        { id: "first", kind: "team", runtimeName: null, slug: "first", value: firstTeam },
        { id: "second", kind: "team", runtimeName: null, slug: "second", value: secondTeam }
      ],
      root: firstTeam.source,
      runtimes: {}
    };

    expect(() => resolveTeamRepresentatives(plan, firstTeam)).toThrow(/Cycle detected/);
  });

  it("rejects representative declarations that reference unknown members", () => {
    const team = createTeam({
      external: ["missing"],
      externalExplicit: true
    });
    const plan: CompilePlan = {
      edges: [],
      nodes: [{ id: "team", kind: "team", runtimeName: null, slug: "team", value: team }],
      root: team.source,
      runtimes: {}
    };

    expect(() => resolveTeamRepresentatives(plan, team)).toThrow(/unknown member missing/);
  });

  it("returns undefined when no attachments are declared", () => {
    expect(resolveMoltnetAttachments(undefined, undefined, "researcher")).toBeUndefined();
    expect(resolveMoltnetAttachments([], undefined, "researcher")).toBeUndefined();
  });

  it("resolves team-scoped moltnet attachments with member context", () => {
    expect(
      resolveMoltnetAttachments(
        [
          {
            memberId: null,
            network: "local_lab",
            rooms: {
              research: {
                read: "mentions",
                reply: "auto"
              }
            },
            teamSource: null
          }
        ],
        {
          memberId: "researcher",
          networks: [
            {
              id: "local_lab",
              name: "Local Lab",
              provider: "moltnet",
              rooms: [
                {
                  id: "research",
                  members: ["researcher", "writer"]
                }
              ]
            }
          ],
          teamName: "research-cell",
          teamSource: "/tmp/team/Spawnfile"
        },
        "researcher"
      )
    ).toEqual([
      {
        memberId: "researcher",
        network: "local_lab",
        rooms: {
          research: {
            read: "mentions",
            reply: "auto"
          }
        },
        teamSource: "/tmp/team/Spawnfile"
      }
    ]);
  });

  it("rejects moltnet attachments outside a team context", () => {
    expect(() =>
      resolveMoltnetAttachments(
        [
          {
            memberId: null,
            network: "local_lab",
            teamSource: null
          }
        ],
        undefined,
        "researcher"
      )
    ).toThrow(/not attached to a team network/);
  });

  it("rejects rooms the member does not belong to", () => {
    expect(() =>
      resolveMoltnetAttachments(
        [
          {
            memberId: null,
            network: "local_lab",
            rooms: {
              research: {
                read: "mentions"
              }
            },
            teamSource: null
          }
        ],
        {
          memberId: "writer",
          networks: [
            {
              id: "local_lab",
              name: "Local Lab",
              provider: "moltnet",
              rooms: [
                {
                  id: "research",
                  members: ["researcher"]
                }
              ]
            }
          ],
          teamName: "research-cell",
          teamSource: "/tmp/team/Spawnfile"
        },
        "writer"
      )
    ).toThrow(/is not in that room/);
  });

  it("rejects unknown networks", () => {
    expect(() =>
      resolveMoltnetAttachments(
        [
          {
            dms: {
              enabled: true
            },
            memberId: null,
            network: "missing",
            teamSource: null
          }
        ],
        {
          memberId: "researcher",
          networks: [],
          teamName: "research-cell",
          teamSource: "/tmp/team/Spawnfile"
        },
        "researcher"
      )
    ).toThrow(/unknown Moltnet network missing/);
  });

  it("rejects unknown rooms on known networks", () => {
    expect(() =>
      resolveMoltnetAttachments(
        [
          {
            memberId: null,
            network: "local_lab",
            rooms: {
              missing: {
                read: "all"
              }
            },
            teamSource: null
          }
        ],
        {
          memberId: "researcher",
          networks: [
            {
              id: "local_lab",
              name: "Local Lab",
              provider: "moltnet",
              rooms: [
                {
                  id: "research",
                  members: ["researcher"]
                }
              ]
            }
          ],
          teamName: "research-cell",
          teamSource: "/tmp/team/Spawnfile"
        },
        "researcher"
      )
    ).toThrow(/unknown Moltnet room missing/);
  });

  it("merges compatible direct and representative moltnet attachments by network and member id", () => {
    const agent = createAgent({
      moltnet: [
        {
          memberId: null,
          network: "org",
          rooms: {
            child_room: {
              read: "mentions"
            }
          },
          teamSource: null
        }
      ]
    });
    const childTeam = createTeam({
      external: ["rep"],
      lead: "rep",
      members: [
        {
          id: "rep",
          kind: "agent",
          nodeSource: agent.source,
          runtimeName: "openclaw"
        }
      ],
      mode: "hierarchical",
      name: "child",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "child_room", members: ["rep"] }]
        }
      ],
      source: "/tmp/child/Spawnfile"
    });
    const parentTeam = createTeam({
      members: [
        {
          id: "child",
          kind: "team",
          nodeSource: childTeam.source,
          runtimeName: null
        }
      ],
      name: "parent",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "parent_room", members: ["child"] }]
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

    resolvePlanMoltnetAttachments(plan);

    expect(agent.surfaces?.moltnet).toEqual([
      {
        contextRooms: {
          [childTeam.source]: ["child_room"],
          [parentTeam.source]: ["parent_room"]
        },
        memberId: "rep",
        network: "org",
        rooms: {
          child_room: {
            read: "mentions"
          },
          parent_room: {}
        },
        teamSource: childTeam.source
      }
    ]);
    expect(parentTeam.networks?.[0]?.rooms[0]?.members).toEqual(["rep"]);
  });

  it("rejects incompatible duplicate moltnet room policies for the same network and member id", () => {
    const agent = createAgent({
      moltnet: [
        {
          memberId: null,
          network: "org",
          rooms: { room: { read: "all" } },
          teamSource: null
        },
        {
          memberId: null,
          network: "org",
          rooms: { room: { read: "mentions" } },
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
          rooms: [{ id: "room", members: ["rep"] }]
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

    expect(() => resolvePlanMoltnetAttachments(plan)).toThrow(/incompatible Moltnet room policy/);
  });

  it("rejects incompatible duplicate dm policies for the same network and member id", () => {
    const agent = createAgent({
      moltnet: [
        {
          dms: { enabled: true, read: "all" },
          memberId: null,
          network: "org",
          teamSource: null
        },
        {
          dms: { enabled: true, read: "mentions" },
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

  it("rejects duplicate moltnet member ids across direct memberships", () => {
    const firstAgent = createAgent({ moltnet: [] });
    const secondAgent = createAgent({ moltnet: [] });
    secondAgent.name = "second";
    secondAgent.source = "/tmp/second/Spawnfile";
    const firstTeam = createTeam({
      members: [
        {
          id: "shared",
          kind: "agent",
          nodeSource: firstAgent.source,
          runtimeName: "openclaw"
        }
      ],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [] }],
      source: "/tmp/first-team/Spawnfile"
    });
    const secondTeam = createTeam({
      members: [
        {
          id: "shared",
          kind: "agent",
          nodeSource: secondAgent.source,
          runtimeName: "openclaw"
        }
      ],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [] }],
      source: "/tmp/second-team/Spawnfile"
    });
    const plan: CompilePlan = {
      edges: [],
      memberships: [
        {
          agentSource: firstAgent.source,
          memberId: "shared",
          teamName: "first",
          teamSource: firstTeam.source
        },
        {
          agentSource: secondAgent.source,
          memberId: "shared",
          teamName: "second",
          teamSource: secondTeam.source
        }
      ],
      nodes: [
        { id: "first-agent", kind: "agent", runtimeName: "openclaw", slug: "first", value: firstAgent },
        { id: "second-agent", kind: "agent", runtimeName: "openclaw", slug: "second", value: secondAgent },
        { id: "first-team", kind: "team", runtimeName: null, slug: "first-team", value: firstTeam },
        { id: "second-team", kind: "team", runtimeName: null, slug: "second-team", value: secondTeam }
      ],
      root: firstTeam.source,
      runtimes: { openclaw: { nodeIds: ["first-agent", "second-agent"] } }
    };

    expect(() => resolvePlanMoltnetAttachments(plan)).toThrow(
      /member_id shared is declared by multiple direct agent member slots/
    );
  });

  it("rejects synthesized representative attachments without a direct member context", () => {
    const agent = createAgent(undefined);
    const childTeam = createTeam({
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
      source: "/tmp/child/Spawnfile"
    });
    const parentTeam = createTeam({
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
          rooms: [{ id: "parent_room", members: ["child"] }]
        }
      ],
      source: "/tmp/parent/Spawnfile"
    });
    const plan: CompilePlan = {
      edges: [],
      nodes: [
        { id: "agent", kind: "agent", runtimeName: "openclaw", slug: "rep", value: agent },
        { id: "child", kind: "team", runtimeName: null, slug: "child", value: childTeam },
        { id: "parent", kind: "team", runtimeName: null, slug: "parent", value: parentTeam }
      ],
      root: parentTeam.source,
      runtimes: { openclaw: { nodeIds: ["agent"] } }
    };

    expect(() => resolvePlanMoltnetAttachments(plan)).toThrow(
      /Unable to find direct member context for synthesized Moltnet member rep/
    );
  });

  it("removes unresolved moltnet declarations when an agent has no resolved attachments", () => {
    const agent = createAgent({ moltnet: [] });
    const team = createTeam({
      members: [
        {
          id: "rep",
          kind: "agent",
          nodeSource: agent.source,
          runtimeName: "openclaw"
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

    resolvePlanMoltnetAttachments(plan);

    expect(agent.surfaces?.moltnet).toBeUndefined();
  });
});
