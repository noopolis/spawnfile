import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { resolveMoltnetRoomMemberships } from "./moltnetRoomMemberships.js";
import { prepareTeamCompileSupport } from "./teamContextSupport.js";
import type { ResolvedMemoryAccess, ResolvedMemoryBank } from "./types.js";
import {
  createTestAgent,
  createTestPlan,
  createTestTeam,
  findTestFile
} from "./teamContextSupport.testHelpers.js";

const baseMemoryIndex = {
  graph: { enabled: false },
  lexical: { enabled: true },
  rerank: { enabled: false },
  vector: { enabled: false }
};

const baseMemoryConsolidation = { mode: "disabled" as const };
const baseMemoryRetention = { forgetting: "manual" as const };

const createTeamMemoryBank = (
  source: string,
  declaredName: string,
  id: string
): ResolvedMemoryBank => ({
  access: undefined,
  consolidation: baseMemoryConsolidation,
  declaredBy: "team",
  declaredName,
  id,
  index: baseMemoryIndex,
  retention: baseMemoryRetention,
  source,
  store: {
    kind: "json",
    path: `${source}/memory/${id}/memory.json`,
    persistence: { mode: "durable" }
  }
});

const createAgentMemoryBank = (
  source: string,
  declaredName: string,
  id: string
): ResolvedMemoryBank => ({
  ...createTeamMemoryBank(source, declaredName, id),
  declaredBy: "agent"
});

const createTeamMemoryAccess = (
  agentSource: string,
  source: string,
  slotId: string,
  teamName: string,
  bankId: string
): ResolvedMemoryAccess => ({
  agentSource,
  declaringKind: "team",
  slotId,
  source,
  bank: createTeamMemoryBank(source, teamName, bankId)
});

describe("prepareTeamCompileSupport", () => {
  it("emits direct and representative contexts with cards, indexes, aliases, and capabilities", async () => {
    const parentSource = "/project/Spawnfile";
    const childSource = "/project/teams/field/Spawnfile";
    const coordinatorSource = "/project/agents/coordinator/Spawnfile";
    const representativeSource = "/project/teams/field/agents/representative/Spawnfile";
    const observerSource = "/project/teams/field/agents/observer/Spawnfile";

    const coordinator = createTestAgent("coordinator", coordinatorSource, {
      moltnet: [
        {
          contextRooms: { [parentSource]: ["mission-control"] },
          memberId: "coordinator",
          network: "org",
          rooms: { "mission-control": {} },
          teamSource: parentSource
        }
      ]
    });
    const representative = createTestAgent("field-representative", representativeSource, {
      moltnet: [
        {
          contextRooms: {
            [childSource]: ["field-room"],
            [parentSource]: ["mission-control"]
          },
          memberId: "field-rep",
          network: "org",
          rooms: {
            "field-room": {},
            "mission-control": {}
          },
          teamSource: childSource
        }
      ],
      slack: {
        appTokenSecret: "SLACK_APP_TOKEN",
        botTokenSecret: "SLACK_BOT_TOKEN",
        identity: { userId: "UFIELD" }
      }
    });
    const observer = createTestAgent("field-observer", observerSource, {
      moltnet: [
        {
          contextRooms: { [childSource]: ["field-room"] },
          memberId: "field-observer",
          network: "org",
          rooms: { "field-room": {} },
          teamSource: childSource
        }
      ]
    });

    const childTeam = createTestTeam({
      external: ["field-rep"],
      externalExplicit: true,
      lead: "field-rep",
      members: [
        {
          id: "field-rep",
          kind: "agent",
          nodeSource: representativeSource,
          runtimeName: "openclaw"
        },
        {
          id: "field-observer",
          kind: "agent",
          nodeSource: observerSource,
          runtimeName: "openclaw"
        }
      ],
      mode: "hierarchical",
      name: "Field Team",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "field-room", members: ["field-rep", "field-observer"] }]
        }
      ],
      source: childSource
    });
    const parentTeam = createTestTeam({
      lead: "coordinator",
      members: [
        {
          id: "coordinator",
          kind: "agent",
          nodeSource: coordinatorSource,
          runtimeName: "openclaw"
        },
        {
          id: "field",
          kind: "team",
          nodeSource: childSource,
          runtimeName: null
        }
      ],
      mode: "hierarchical",
      name: "Org Council",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "mission-control", members: ["coordinator", "field-rep"] }]
        }
      ],
      source: parentSource
    });
    const plan = createTestPlan([coordinator, representative, observer], [parentTeam, childTeam], [
      {
        agentSource: coordinatorSource,
        memberId: "coordinator",
        teamName: parentTeam.name,
        teamSource: parentSource
      },
      {
        agentSource: representativeSource,
        memberId: "field-rep",
        teamName: childTeam.name,
        teamSource: childSource
      },
      {
        agentSource: observerSource,
        memberId: "field-observer",
        teamName: childTeam.name,
        teamSource: childSource
      }
    ]);

    const support = await prepareTeamCompileSupport(plan);
    const representativeFiles = support.filesByAgentSource.get(representativeSource) ?? [];
    const coordinatorFiles = support.filesByAgentSource.get(coordinatorSource) ?? [];
    const representativeIndex = YAML.parse(
      findTestFile(representativeFiles, ".spawnfile/team-contexts.yaml").content
    ) as {
      direct_memberships: Array<Record<string, unknown>>;
      representations: Array<Record<string, unknown>>;
    };

    expect(representativeIndex.direct_memberships).toHaveLength(1);
    expect(representativeIndex.direct_memberships[0]).toMatchObject({
      aliases: { roster: ".spawnfile/roster.yaml", team_doc: "TEAM.md" },
      context_key: "field-team",
      member: "field-rep",
      team: "Field Team"
    });
    expect(representativeIndex.representations[0]).toMatchObject({
      context_key: "org-council--field",
      delegate_role: "representative",
      representative: "field-rep",
      represents: "field",
      team: "Org Council"
    });
    expect(representativeIndex.representations[0]?.surfaces).toEqual({
      moltnet: [{ network: "org", rooms: ["mission-control"] }]
    });
    expect(findTestFile(representativeFiles, "TEAM.md").content).toContain(
      "# Field Team operating context"
    );
    expect(
      findTestFile(representativeFiles, ".spawnfile/team-contexts/org-council--field/TEAM.md").content
    ).toContain("# Org Council operating context");
    expect(findTestFile(representativeFiles, ".spawnfile/team-contexts.md").content).toContain(
      "Do not merge team documents."
    );
    expect(findTestFile(representativeFiles, ".spawnfile/team-contexts.md").content).toContain(
      "Moltnet: `org` / room `mission-control`"
    );
    expect(findTestFile(representativeFiles, ".spawnfile/team-contexts.md").content).toContain(
      ".spawnfile/team-contexts.yaml"
    );

    expect(
      findTestFile(coordinatorFiles, ".spawnfile/team-cards/org-council/field.md").content
    ).toContain("- `field-rep`");
    expect(
      support.capabilitiesByTeamSource.get(parentSource)?.map((capability) => capability.key)
    ).toEqual([
      "team.roster",
      "team.context_orientation",
      "team.active_environments",
      "team.representatives",
      "team.networks",
      "team.networks.moltnet",
      "team.networks.moltnet.org"
    ]);
    expect(support.diagnosticsByTeamSource.get(parentSource) ?? []).toEqual([]);
  });

  it("omits root aliases for multiple direct memberships without ambiguity warnings", async () => {
    const alphaSource = "/project/teams/alpha/Spawnfile";
    const betaSource = "/project/teams/beta/Spawnfile";
    const agentSource = "/project/agents/qc/Spawnfile";
    const qcAgent = createTestAgent("qc", agentSource, {
      moltnet: [
        {
          contextRooms: { [alphaSource]: ["common"] },
          memberId: "alpha-qc",
          network: "org",
          rooms: { common: {} },
          teamSource: alphaSource
        },
        {
          contextRooms: { [betaSource]: ["common"] },
          memberId: "beta-qc",
          network: "org",
          rooms: { common: {} },
          teamSource: betaSource
        }
      ]
    });
    const alphaTeam = createTestTeam({
      members: [
        {
          id: "alpha-qc",
          kind: "agent",
          nodeSource: agentSource,
          runtimeName: "openclaw"
        }
      ],
      name: "Alpha",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "common", members: ["alpha-qc"] }]
        }
      ],
      source: alphaSource
    });
    const betaTeam = createTestTeam({
      members: [
        {
          id: "beta-qc",
          kind: "agent",
          nodeSource: agentSource,
          runtimeName: "openclaw"
        }
      ],
      name: "Beta",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "common", members: ["beta-qc"] }]
        }
      ],
      source: betaSource
    });
    const plan = createTestPlan([qcAgent], [alphaTeam, betaTeam], [
      {
        agentSource,
        memberId: "alpha-qc",
        teamName: alphaTeam.name,
        teamSource: alphaSource
      },
      {
        agentSource,
        memberId: "beta-qc",
        teamName: betaTeam.name,
        teamSource: betaSource
      }
    ]);

    const support = await prepareTeamCompileSupport(plan);
    const files = support.filesByAgentSource.get(agentSource) ?? [];

    expect(files.some((file) => file.path === "TEAM.md")).toBe(false);
    expect(files.some((file) => file.path === ".spawnfile/roster.yaml")).toBe(false);
    expect(support.diagnosticsByTeamSource.get(alphaSource) ?? []).toEqual([]);
    expect(support.diagnosticsByTeamSource.get(betaSource) ?? []).toEqual([]);
  });

  it("warns when an implicit nested swarm team is exposed as the parent lead", async () => {
    const parentSource = "/project/parent/Spawnfile";
    const childSource = "/project/child/Spawnfile";
    const firstAgentSource = "/project/child/agents/first/Spawnfile";
    const secondAgentSource = "/project/child/agents/second/Spawnfile";
    const firstAgent = createTestAgent("first", firstAgentSource);
    const secondAgent = createTestAgent("second", secondAgentSource);
    const childTeam = createTestTeam({
      members: [
        {
          id: "first",
          kind: "agent",
          nodeSource: firstAgentSource,
          runtimeName: "openclaw"
        },
        {
          id: "second",
          kind: "agent",
          nodeSource: secondAgentSource,
          runtimeName: "openclaw"
        }
      ],
      mode: "swarm",
      name: "Child Swarm",
      source: childSource
    });
    const parentTeam = createTestTeam({
      lead: "child",
      members: [
        {
          id: "child",
          kind: "team",
          nodeSource: childSource,
          runtimeName: null
        }
      ],
      mode: "hierarchical",
      name: "Parent",
      networks: [
        {
          id: "org.net",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "council", members: ["child"] }]
        }
      ],
      source: parentSource
    });

    const support = await prepareTeamCompileSupport(
      createTestPlan([firstAgent, secondAgent], [parentTeam, childTeam], [
        {
          agentSource: firstAgentSource,
          memberId: "first",
          teamName: childTeam.name,
          teamSource: childSource
        },
        {
          agentSource: secondAgentSource,
          memberId: "second",
          teamName: childTeam.name,
          teamSource: childSource
        }
      ])
    );

    expect(
      support.capabilitiesByTeamSource.get(parentSource)?.map((capability) => capability.key)
    ).toContain("team.networks.moltnet.org%2Enet");
    expect(
      support.diagnosticsByTeamSource.get(parentSource)?.map((diagnostic) => diagnostic.message)
    ).toEqual([
      "Nested swarm team Child Swarm is exposed without explicit external representatives",
      "Team Parent lead child resolves to multiple implicit representatives"
    ]);
  });

  it("emits separate direct contexts for one canonical agent imported by three teams", async () => {
    const agentSource = "/project/agents/eleanor/Spawnfile";
    const officeSource = "/project/teams/office/Spawnfile";
    const familySource = "/project/teams/eleanor-family/Spawnfile";
    const friendsSource = "/project/teams/friends-group/Spawnfile";
    const agent = createTestAgent("eleanor", agentSource);
    const teams = [
      createTestTeam({
        members: [{ id: "eleanor", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
        name: "Office",
        source: officeSource
      }),
      createTestTeam({
        members: [{ id: "eleanor", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
        name: "Eleanor Family",
        source: familySource
      }),
      createTestTeam({
        members: [{ id: "eleanor", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
        name: "Friends Group",
        source: friendsSource
      })
    ];

    const support = await prepareTeamCompileSupport(createTestPlan([agent], teams, [
      {
        agentSource,
        memberId: "eleanor",
        teamName: "Office",
        teamSource: officeSource
      },
      {
        agentSource,
        memberId: "eleanor",
        teamName: "Eleanor Family",
        teamSource: familySource
      },
      {
        agentSource,
        memberId: "eleanor",
        teamName: "Friends Group",
        teamSource: friendsSource
      }
    ]));
    const files = support.filesByAgentSource.get(agentSource) ?? [];
    const index = YAML.parse(findTestFile(files, ".spawnfile/team-contexts.yaml").content) as {
      direct_memberships: Array<{ context_key: string; member: string; team: string; team_doc: string }>;
      representations: unknown[];
    };

    expect(files.some((file) => file.path === "TEAM.md")).toBe(false);
    expect(files.some((file) => file.path === ".spawnfile/roster.yaml")).toBe(false);
    expect(index.representations).toEqual([]);
    expect(index.direct_memberships.map((entry) => entry.team).sort()).toEqual([
      "Eleanor Family",
      "Friends Group",
      "Office"
    ]);
    expect(index.direct_memberships.every((entry) => entry.member === "eleanor")).toBe(true);
    expect(index.direct_memberships.map((entry) => entry.team_doc).sort()).toEqual([
      ".spawnfile/team-contexts/eleanor-family/TEAM.md",
      ".spawnfile/team-contexts/friends-group/TEAM.md",
      ".spawnfile/team-contexts/office/TEAM.md"
    ]);
  });

  it("derives shared room active context from first listed team member", async () => {
    const agentSource = "/project/agents/eleanor/Spawnfile";
    const alphaSource = "/project/teams/alpha/Spawnfile";
    const betaSource = "/project/teams/beta/Spawnfile";
    const rootSource = "/project/Spawnfile";
    const agent = createTestAgent("eleanor", agentSource);
    const alphaTeam = createTestTeam({
      external: ["eleanor"],
      externalExplicit: true,
      members: [{ id: "eleanor", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
      name: "Alpha",
      source: alphaSource
    });
    const betaTeam = createTestTeam({
      external: ["eleanor"],
      externalExplicit: true,
      members: [{ id: "eleanor", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
      name: "Beta",
      source: betaSource
    });
    const rootTeam = createTestTeam({
      members: [
        { id: "beta", kind: "team", nodeSource: betaSource, runtimeName: null },
        { id: "alpha", kind: "team", nodeSource: alphaSource, runtimeName: null }
      ],
      name: "Root",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "shared", members: ["beta", "alpha"] }]
        }
      ],
      source: rootSource
    });
    const plan = createTestPlan([agent], [rootTeam, alphaTeam, betaTeam], [
      { agentSource, memberId: "eleanor", teamName: "Alpha", teamSource: alphaSource },
      { agentSource, memberId: "eleanor", teamName: "Beta", teamSource: betaSource }
    ]);
    plan.moltnetRoomMemberships = resolveMoltnetRoomMemberships(plan);

    const support = await prepareTeamCompileSupport(plan);
    const index = YAML.parse(
      findTestFile(support.filesByAgentSource.get(agentSource) ?? [], ".spawnfile/team-contexts.yaml").content
    ) as {
      active_environments: {
        moltnet: Record<string, { rooms: Record<string, { context_key: string; derivation: { member_position: number } }> }>;
      };
    };

    expect(index.active_environments.moltnet.org.rooms.shared).toMatchObject({
      context_key: "root--beta",
      derivation: { member_position: 0 }
    });
  });

  it("flips shared room active context when authored members are reordered", async () => {
    const agentSource = "/project/agents/eleanor/Spawnfile";
    const alphaSource = "/project/teams/alpha/Spawnfile";
    const betaSource = "/project/teams/beta/Spawnfile";
    const rootSource = "/project/Spawnfile";
    const agent = createTestAgent("eleanor", agentSource);
    const alphaTeam = createTestTeam({
      external: ["eleanor"],
      externalExplicit: true,
      members: [{ id: "eleanor", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
      name: "Alpha",
      source: alphaSource
    });
    const betaTeam = createTestTeam({
      external: ["eleanor"],
      externalExplicit: true,
      members: [{ id: "eleanor", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
      name: "Beta",
      source: betaSource
    });
    const rootTeam = createTestTeam({
      members: [
        { id: "alpha", kind: "team", nodeSource: alphaSource, runtimeName: null },
        { id: "beta", kind: "team", nodeSource: betaSource, runtimeName: null }
      ],
      name: "Root",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "shared", members: ["alpha", "beta"] }]
        }
      ],
      source: rootSource
    });
    const plan = createTestPlan([agent], [rootTeam, alphaTeam, betaTeam], [
      { agentSource, memberId: "eleanor", teamName: "Alpha", teamSource: alphaSource },
      { agentSource, memberId: "eleanor", teamName: "Beta", teamSource: betaSource }
    ]);
    plan.moltnetRoomMemberships = resolveMoltnetRoomMemberships(plan);

    const support = await prepareTeamCompileSupport(plan);
    const index = YAML.parse(
      findTestFile(support.filesByAgentSource.get(agentSource) ?? [], ".spawnfile/team-contexts.yaml").content
    ) as {
      active_environments: {
        moltnet: Record<string, { rooms: Record<string, { context_key: string; derivation: { member_position: number } }> }>;
      };
    };

    expect(index.active_environments.moltnet.org.rooms.shared).toMatchObject({
      context_key: "root--alpha",
      derivation: { member_position: 0 }
    });
  });

  it("uses representative context for parent rooms that contain a child team", async () => {
    const agentSource = "/project/teams/field/agents/rep/Spawnfile";
    const childSource = "/project/teams/field/Spawnfile";
    const rootSource = "/project/Spawnfile";
    const agent = createTestAgent("rep", agentSource);
    const childTeam = createTestTeam({
      external: ["rep"],
      externalExplicit: true,
      members: [{ id: "rep", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
      name: "Field",
      source: childSource
    });
    const rootTeam = createTestTeam({
      members: [{ id: "field", kind: "team", nodeSource: childSource, runtimeName: null }],
      name: "Root Org",
      networks: [
        {
          id: "org",
          name: "Org",
          provider: "moltnet",
          rooms: [{ id: "mission-control", members: ["field"] }]
        }
      ],
      source: rootSource
    });
    const plan = createTestPlan([agent], [rootTeam, childTeam], [
      { agentSource, memberId: "rep", teamName: "Field", teamSource: childSource }
    ]);
    plan.moltnetRoomMemberships = resolveMoltnetRoomMemberships(plan);

    const support = await prepareTeamCompileSupport(plan);
    const index = YAML.parse(
      findTestFile(support.filesByAgentSource.get(agentSource) ?? [], ".spawnfile/team-contexts.yaml").content
    ) as {
      active_environments: {
        moltnet: Record<string, { rooms: Record<string, { context_key: string; member_slot: string; team_doc: string }> }>;
      };
    };

    expect(index.active_environments.moltnet.org.rooms["mission-control"]).toMatchObject({
      context_key: "root-org--field",
      member_slot: "field",
      team_doc: ".spawnfile/team-contexts/root-org--field/TEAM.md"
    });
  });

  it("derives schedules to the only direct context or global self", async () => {
    const singleAgentSource = "/project/agents/single/Spawnfile";
    const singleTeamSource = "/project/teams/single/Spawnfile";
    const singleAgent = createTestAgent("single", singleAgentSource);
    singleAgent.schedule = { kind: "every", every: "1m" };
    const singleTeam = createTestTeam({
      members: [{ id: "single", kind: "agent", nodeSource: singleAgentSource, runtimeName: "openclaw" }],
      name: "Single Team",
      source: singleTeamSource
    });
    const singleSupport = await prepareTeamCompileSupport(createTestPlan([singleAgent], [singleTeam], [
      { agentSource: singleAgentSource, memberId: "single", teamName: "Single Team", teamSource: singleTeamSource }
    ]));
    const singleIndex = YAML.parse(
      findTestFile(singleSupport.filesByAgentSource.get(singleAgentSource) ?? [], ".spawnfile/team-contexts.yaml").content
    ) as { active_environments: { schedules: Record<string, { context_key: string }> } };

    expect(singleIndex.active_environments.schedules.default.context_key).toBe("single-team");

    const multiAgentSource = "/project/agents/multi/Spawnfile";
    const firstTeamSource = "/project/teams/first/Spawnfile";
    const secondTeamSource = "/project/teams/second/Spawnfile";
    const multiAgent = createTestAgent("multi", multiAgentSource);
    multiAgent.schedule = { kind: "every", every: "1m" };
    const firstTeam = createTestTeam({
      members: [{ id: "multi", kind: "agent", nodeSource: multiAgentSource, runtimeName: "openclaw" }],
      name: "First Team",
      source: firstTeamSource
    });
    const secondTeam = createTestTeam({
      members: [{ id: "multi", kind: "agent", nodeSource: multiAgentSource, runtimeName: "openclaw" }],
      name: "Second Team",
      source: secondTeamSource
    });
    const multiSupport = await prepareTeamCompileSupport(createTestPlan([multiAgent], [firstTeam, secondTeam], [
      { agentSource: multiAgentSource, memberId: "multi", teamName: "First Team", teamSource: firstTeamSource },
      { agentSource: multiAgentSource, memberId: "multi", teamName: "Second Team", teamSource: secondTeamSource }
    ]));
    const multiIndex = YAML.parse(
      findTestFile(multiSupport.filesByAgentSource.get(multiAgentSource) ?? [], ".spawnfile/team-contexts.yaml").content
    ) as { active_environments: { schedules: Record<string, { context_key: string }> } };

    expect(multiIndex.active_environments.schedules.default.context_key).toBe("self");
  });

  it("derives dreams from self and memory-bearing team scopes", async () => {
    const agentSource = "/project/agents/eleanor/Spawnfile";
    const officeSource = "/project/teams/office/Spawnfile";
    const friendsSource = "/project/teams/friends/Spawnfile";
    const agent = createTestAgent("eleanor", agentSource);
    const officeMember = "office-agent";
    const friendsMember = "friends-agent";

    const officeTeam = createTestTeam({
      members: [
        { id: officeMember, kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }
      ],
      name: "Office",
      source: officeSource
    });
    const friendsTeam = createTestTeam({
      members: [
        { id: friendsMember, kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }
      ],
      name: "Friends",
      source: friendsSource
    });

    agent.memoryAccess = [
      createTeamMemoryAccess(
        agentSource,
        officeSource,
        officeMember,
        "Office",
        "office-memory"
      )
    ];

    const support = await prepareTeamCompileSupport(
      createTestPlan([agent], [officeTeam, friendsTeam], [
        {
          agentSource,
          memberId: officeMember,
          teamName: "Office",
          teamSource: officeSource
        },
        {
          agentSource,
          memberId: friendsMember,
          teamName: "Friends",
          teamSource: friendsSource
        }
      ])
    );

    const index = YAML.parse(
      findTestFile(support.filesByAgentSource.get(agentSource) ?? [], ".spawnfile/team-contexts.yaml").content
    ) as { active_environments: { dreams: Record<string, { context_key: string }> } };

    expect(Object.keys(index.active_environments.dreams).sort()).toEqual(["office", "self"]);
    expect(index.active_environments.dreams.self.context_key).toBe("self");
    expect(index.active_environments.dreams.office.context_key).toBe("office");
    expect(index.active_environments.dreams.friends).toBeUndefined();
  });

  it("derives all team dreams when an agent-owned memory bank can store scoped principals", async () => {
    const agentSource = "/project/agents/eleanor/Spawnfile";
    const officeSource = "/project/teams/office/Spawnfile";
    const friendsSource = "/project/teams/friends/Spawnfile";
    const agent = createTestAgent("eleanor", agentSource);
    agent.memory = [createAgentMemoryBank(agentSource, "self", "self-memory")];

    const officeTeam = createTestTeam({
      members: [{ id: "office-agent", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
      name: "Office",
      source: officeSource
    });
    const friendsTeam = createTestTeam({
      members: [{ id: "friends-agent", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
      name: "Friends",
      source: friendsSource
    });

    const support = await prepareTeamCompileSupport(
      createTestPlan([agent], [officeTeam, friendsTeam], [
        {
          agentSource,
          memberId: "office-agent",
          teamName: "Office",
          teamSource: officeSource
        },
        {
          agentSource,
          memberId: "friends-agent",
          teamName: "Friends",
          teamSource: friendsSource
        }
      ])
    );

    const index = YAML.parse(
      findTestFile(support.filesByAgentSource.get(agentSource) ?? [], ".spawnfile/team-contexts.yaml").content
    ) as { active_environments: { dreams: Record<string, { context_key: string }> } };

    expect(Object.keys(index.active_environments.dreams).sort()).toEqual(["friends", "office", "self"]);
  });

  it("emits self schedule and dream environments for standalone agents", async () => {
    const agentSource = "/project/agents/solo/Spawnfile";
    const agent = createTestAgent("solo", agentSource);
    agent.schedule = { kind: "every", every: "1m" };
    agent.memory = [createAgentMemoryBank(agentSource, "solo", "solo-memory")];

    const support = await prepareTeamCompileSupport(createTestPlan([agent], [], []));
    const index = YAML.parse(
      findTestFile(support.filesByAgentSource.get(agentSource) ?? [], ".spawnfile/team-contexts.yaml").content
    ) as {
      active_environments: {
        schedules: Record<string, { context_key: string; memory: { durable_scope: { scope: string } } }>;
        dreams: Record<string, { context_key: string; memory: { durable_scope: { scope: string } } }>;
      };
      direct_memberships: unknown[];
      representations: unknown[];
    };

    expect(index.direct_memberships).toEqual([]);
    expect(index.representations).toEqual([]);
    expect(index.active_environments.schedules.default).toMatchObject({
      context_key: "self",
      memory: { durable_scope: { scope: "global" } }
    });
    expect(index.active_environments.dreams.self).toMatchObject({
      context_key: "self",
      memory: { durable_scope: { scope: "global" } }
    });
  });
});
