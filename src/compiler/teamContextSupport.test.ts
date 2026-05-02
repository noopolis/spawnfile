import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareTeamCompileSupport } from "./teamContextSupport.js";
import {
  createTestAgent,
  createTestPlan,
  createTestTeam,
  findTestFile
} from "./teamContextSupport.testHelpers.js";

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
      "team.representatives",
      "team.networks",
      "team.networks.moltnet",
      "team.networks.moltnet.org"
    ]);
    expect(support.diagnosticsByTeamSource.get(parentSource) ?? []).toEqual([]);
  });

  it("warns on ambiguous shared bindings and omits root aliases for multiple direct memberships", async () => {
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
    expect(
      support.diagnosticsByTeamSource.get(alphaSource)?.map((diagnostic) => diagnostic.message)
    ).toContain("Agent qc maps moltnet:org:common to multiple team contexts: alpha, beta");
    expect(
      support.diagnosticsByTeamSource.get(betaSource)?.map((diagnostic) => diagnostic.message)
    ).toContain("Agent qc maps moltnet:org:common to multiple team contexts: alpha, beta");
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
});
