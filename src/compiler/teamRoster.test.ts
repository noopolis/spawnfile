import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { generateTeamRoster, generateTeamRosters, Roster } from "./teamRoster.js";
import { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const makeAgentNode = (
  name: string,
  source: string,
  description: string,
  surfaces?: ResolvedAgentNode["surfaces"]
): ResolvedAgentNode => ({
  description,
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name,
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options: {} },
  secrets: [],
  skills: [],
  source,
  surfaces,
  subagents: []
});

const makeTeamNodeValue = (name: string, source: string, description: string): ResolvedTeamNode => ({
  description,
  docs: [],
  external: [],
  kind: "team",
  lead: null,
  members: [],
  mode: "swarm",
  name,
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source
});

const makeTeamNode = (overrides: Partial<ResolvedTeamNode>): ResolvedTeamNode => ({
  description: "Test team",
  docs: [],
  external: [],
  kind: "team",
  lead: null,
  members: [],
  mode: "swarm",
  name: "team",
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: "/project/Spawnfile",
  ...overrides
});

const parseRoster = (yamlString: string): Roster => YAML.parse(yamlString) as Roster;

describe("generateTeamRosters", () => {
  const makePlan = (
    agents: Array<{
      description: string;
      name: string;
      source: string;
      surfaces?: ResolvedAgentNode["surfaces"];
    }>,
    teams?: Array<{ name: string; source: string; description: string }>
  ): CompilePlan => ({
    edges: [],
    nodes: [
      ...agents.map((agent) => ({
        id: `agent:${agent.name}`,
        kind: "agent" as const,
        runtimeName: "openclaw",
        slug: agent.name,
        value: makeAgentNode(agent.name, agent.source, agent.description, agent.surfaces)
      })),
      ...(teams ?? []).map((team) => ({
        id: `team:${team.name}`,
        kind: "team" as const,
        runtimeName: null,
        slug: team.name,
        value: makeTeamNodeValue(team.name, team.source, team.description)
      }))
    ],
    root: "/project/Spawnfile",
    runtimes: { openclaw: { nodeIds: agents.map((agent) => `agent:${agent.name}`) } }
  });

  it("keeps hierarchical lead visibility and emits address-less member entries", () => {
    const teamNode = makeTeamNode({
      lead: "alice",
      members: [
        { id: "alice", kind: "agent", nodeSource: "/project/alice/Spawnfile", runtimeName: "openclaw" },
        { id: "bob", kind: "agent", nodeSource: "/project/bob/Spawnfile", runtimeName: "openclaw" },
        { id: "carol", kind: "agent", nodeSource: "/project/carol/Spawnfile", runtimeName: "openclaw" }
      ],
      mode: "hierarchical",
      name: "engineering"
    });
    const plan = makePlan([
      { name: "alice", source: "/project/alice/Spawnfile", description: "Team lead" },
      { name: "bob", source: "/project/bob/Spawnfile", description: "Backend dev" },
      { name: "carol", source: "/project/carol/Spawnfile", description: "Frontend dev" }
    ]);

    const { rosters } = generateTeamRosters(teamNode, plan);

    const aliceRoster = parseRoster(rosters.get("alice")!);
    expect(aliceRoster.self).toBe("alice");
    expect(Object.keys(aliceRoster.members).sort()).toEqual(["bob", "carol"]);
    expect(aliceRoster.members.bob).toEqual({
      role: "member",
      description: "Backend dev",
      surfaces: [],
      addresses: {}
    });
    expect(aliceRoster.members.bob).not.toHaveProperty("endpoint");
    expect(aliceRoster.members.bob).not.toHaveProperty("name");

    const bobRoster = parseRoster(rosters.get("bob")!);
    expect(Object.keys(bobRoster.members)).toEqual(["alice"]);
    expect(bobRoster.members.alice?.role).toBe("lead");
  });

  it("keeps swarm visibility for every other member", () => {
    const teamNode = makeTeamNode({
      members: [
        { id: "alpha", kind: "agent", nodeSource: "/project/alpha/Spawnfile", runtimeName: "openclaw" },
        { id: "beta", kind: "agent", nodeSource: "/project/beta/Spawnfile", runtimeName: "openclaw" },
        { id: "gamma", kind: "agent", nodeSource: "/project/gamma/Spawnfile", runtimeName: "openclaw" }
      ],
      mode: "swarm",
      name: "research"
    });
    const plan = makePlan([
      { name: "alpha", source: "/project/alpha/Spawnfile", description: "Researcher A" },
      { name: "beta", source: "/project/beta/Spawnfile", description: "Researcher B" },
      { name: "gamma", source: "/project/gamma/Spawnfile", description: "Researcher C" }
    ]);

    const { rosters } = generateTeamRosters(teamNode, plan);

    const alphaRoster = parseRoster(rosters.get("alpha")!);
    expect(Object.keys(alphaRoster.members).sort()).toEqual(["beta", "gamma"]);

    const betaRoster = parseRoster(rosters.get("beta")!);
    expect(Object.keys(betaRoster.members).sort()).toEqual(["alpha", "gamma"]);
  });

  it("does not emit router auth or external routing metadata", () => {
    const teamNode = makeTeamNode({
      external: ["lead-agent"],
      lead: "lead-agent",
      members: [
        { id: "lead-agent", kind: "agent", nodeSource: "/project/lead/Spawnfile", runtimeName: "openclaw" },
        { id: "worker", kind: "agent", nodeSource: "/project/worker/Spawnfile", runtimeName: "openclaw" }
      ],
      mode: "hierarchical",
      name: "mixed"
    });
    const plan = makePlan([
      { name: "lead-agent", source: "/project/lead/Spawnfile", description: "Lead" },
      { name: "worker", source: "/project/worker/Spawnfile", description: "Worker" }
    ]);

    const roster = parseRoster(generateTeamRosters(teamNode, plan).rosters.get("worker")!);

    expect(roster).not.toHaveProperty("auth");
    expect(roster).not.toHaveProperty("external");
  });

  it("pulls descriptions from member nodes in the plan", () => {
    const teamNode = makeTeamNode({
      members: [
        { id: "writer", kind: "agent", nodeSource: "/project/writer/Spawnfile", runtimeName: "openclaw" },
        { id: "reviewer", kind: "agent", nodeSource: "/project/reviewer/Spawnfile", runtimeName: "openclaw" }
      ],
      mode: "swarm",
      name: "content"
    });
    const plan = makePlan([
      { name: "writer", source: "/project/writer/Spawnfile", description: "Writes articles" },
      { name: "reviewer", source: "/project/reviewer/Spawnfile", description: "Reviews drafts" }
    ]);

    const writerRoster = parseRoster(generateTeamRosters(teamNode, plan).rosters.get("writer")!);

    expect(writerRoster.members.reviewer?.description).toBe("Reviews drafts");
  });

  it("emits context-scoped moltnet addresses and declared surface identities", () => {
    const teamSource = "/project/Spawnfile";
    const teamNode = makeTeamNode({
      members: [
        { id: "alice", kind: "agent", nodeSource: "/project/alice/Spawnfile", runtimeName: "openclaw" },
        { id: "bob", kind: "agent", nodeSource: "/project/bob/Spawnfile", runtimeName: "openclaw" }
      ],
      mode: "swarm",
      name: "research",
      source: teamSource
    });
    const plan = makePlan([
      {
        name: "alice",
        source: "/project/alice/Spawnfile",
        description: "Lead researcher",
        surfaces: {
          moltnet: [
            {
              contextRooms: { [teamSource]: ["lab"] },
              memberId: "alice",
              network: "local_lab",
              rooms: { lab: {} },
              teamSource
            }
          ]
        }
      },
      {
        name: "bob",
        source: "/project/bob/Spawnfile",
        description: "Reviewer",
        surfaces: {
          moltnet: [
            {
              contextRooms: { [teamSource]: ["lab"] },
              memberId: "bob",
              network: "local_lab",
              rooms: { lab: {} },
              teamSource
            }
          ],
          slack: {
            appTokenSecret: "SLACK_APP_TOKEN",
            botTokenSecret: "SLACK_BOT_TOKEN",
            identity: { userId: "U123" }
          }
        }
      }
    ]);

    const aliceRoster = parseRoster(generateTeamRosters(teamNode, plan).rosters.get("alice")!);

    expect(aliceRoster.members.bob?.surfaces).toEqual(["moltnet", "slack"]);
    expect(aliceRoster.members.bob?.addresses).toEqual({
      slack: { user_id: "U123" },
      moltnet: {
        local_lab: {
          fqid: "molt://local_lab/agents/bob",
          rooms: ["lab"]
        }
      }
    });
  });

  it("marks nested team members with role team", () => {
    const teamNode = makeTeamNode({
      lead: "coordinator",
      members: [
        { id: "coordinator", kind: "agent", nodeSource: "/project/coord/Spawnfile", runtimeName: "openclaw" },
        { id: "sub-team", kind: "team", nodeSource: "/project/sub/Spawnfile", runtimeName: null }
      ],
      mode: "hierarchical",
      name: "org"
    });
    const plan = makePlan(
      [{ name: "coordinator", source: "/project/coord/Spawnfile", description: "Coordinator agent" }],
      [{ name: "sub-team", source: "/project/sub/Spawnfile", description: "Sub-team for backend" }]
    );

    const coordRoster = parseRoster(generateTeamRosters(teamNode, plan).rosters.get("coordinator")!);

    expect(coordRoster.members["sub-team"]).toEqual({
      addresses: {},
      card: {
        path: ".spawnfile/team-cards/org/sub-team.md",
        summary: "Sub-team for backend"
      },
      description: "Sub-team for backend",
      representatives: {},
      role: "team",
      surfaces: []
    });
  });

  it("returns an empty description when a member node is not found in the plan", () => {
    const teamNode = makeTeamNode({
      members: [
        { id: "known", kind: "agent", nodeSource: "/project/known/Spawnfile", runtimeName: "openclaw" },
        { id: "ghost", kind: "agent", nodeSource: "/project/ghost/Spawnfile", runtimeName: "openclaw" }
      ],
      mode: "swarm",
      name: "partial"
    });
    const plan = makePlan([
      { name: "known", source: "/project/known/Spawnfile", description: "Known agent" }
    ]);

    const knownRoster = parseRoster(generateTeamRosters(teamNode, plan).rosters.get("known")!);

    expect(knownRoster.members.ghost?.description).toBe("");
  });

  it("warns when visible participants have no shared coordination surface", () => {
    const teamNode = makeTeamNode({
      members: [
        { id: "alpha", kind: "agent", nodeSource: "/project/alpha/Spawnfile", runtimeName: "openclaw" },
        { id: "beta", kind: "agent", nodeSource: "/project/beta/Spawnfile", runtimeName: "openclaw" },
        { id: "gamma", kind: "agent", nodeSource: "/project/gamma/Spawnfile", runtimeName: "openclaw" }
      ],
      mode: "swarm",
      name: "isolated"
    });
    const plan = makePlan([
      { name: "alpha", source: "/project/alpha/Spawnfile", description: "Alpha" },
      { name: "beta", source: "/project/beta/Spawnfile", description: "Beta" },
      { name: "gamma", source: "/project/gamma/Spawnfile", description: "Gamma" }
    ]);

    const result = generateTeamRoster(teamNode, plan, {
      contextKey: "isolated",
      selfMemberId: "alpha",
      teamSource: teamNode.source
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "Team isolated context has no shared coordination surface between visible participants",
      "Team isolated member alpha has no shared coordination surface with any visible teammate",
      "Team isolated member beta has no shared coordination surface with any visible teammate",
      "Team isolated member gamma has no shared coordination surface with any visible teammate"
    ]);
  });

  it("marks representative contexts with the represented slot and platform identities", () => {
    const childTeamSource = "/project/field/Spawnfile";
    const parentTeamSource = "/project/parent/Spawnfile";
    const childTeam = makeTeamNode({
      external: ["delegate"],
      externalExplicit: true,
      members: [
        { id: "delegate", kind: "agent", nodeSource: "/project/delegate/Spawnfile", runtimeName: "openclaw" }
      ],
      name: "field",
      source: childTeamSource
    });
    const parentTeam = makeTeamNode({
      lead: "field-team",
      members: [
        { id: "field-team", kind: "team", nodeSource: childTeamSource, runtimeName: null },
        { id: "observer", kind: "agent", nodeSource: "/project/observer/Spawnfile", runtimeName: "openclaw" }
      ],
      mode: "hierarchical",
      name: "parent",
      source: parentTeamSource
    });
    const plan = makePlan(
      [
        {
          name: "delegate",
          source: "/project/delegate/Spawnfile",
          description: "Delegate",
          surfaces: {
            discord: {
              botTokenSecret: "DISCORD_BOT_TOKEN",
              identity: { userId: "D123" }
            },
            telegram: {
              botTokenSecret: "TELEGRAM_BOT_TOKEN",
              identity: { username: "delegate_bot" }
            },
            whatsapp: {
              identity: { phone: "+15551234567" }
            }
          }
        },
        {
          name: "observer",
          source: "/project/observer/Spawnfile",
          description: "Observer"
        }
      ],
      [
        { name: "field", source: childTeamSource, description: "Field team" },
        { name: "parent", source: parentTeamSource, description: "Parent team" }
      ]
    );
    const childNode = plan.nodes.find((node) => node.value.source === childTeamSource);
    if (childNode) {
      childNode.value = childTeam;
    }
    const parentNode = plan.nodes.find((node) => node.value.source === parentTeamSource);
    if (parentNode) {
      parentNode.value = parentTeam;
    }

    const roster = parseRoster(
      generateTeamRoster(parentTeam, plan, {
        contextKey: "parent--field-team",
        delegateRole: "lead",
        representedSlotId: "field-team",
        selfMemberId: "delegate",
        teamSource: parentTeamSource
      }).roster
    );

    expect(roster.context_kind).toBe("representative");
    expect(roster.represents).toEqual({
      delegate_role: "lead",
      representative: "delegate",
      slot: "field-team"
    });
    expect(roster.members.observer?.role).toBe("member");
    expect(roster.self).toBe("delegate");

    const observerRoster = parseRoster(
      generateTeamRoster(parentTeam, plan, {
        contextKey: "parent",
        selfMemberId: "observer",
        teamSource: parentTeamSource
      }).roster
    );
    expect(observerRoster.members["field-team"]?.representatives?.delegate.addresses).toEqual({
      discord: { user_id: "D123" },
      telegram: { username: "delegate_bot" },
      whatsapp: { phone: "+15551234567" }
    });
  });
});
