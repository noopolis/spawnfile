import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { generateTeamRosters, Roster } from "./teamRoster.js";
import { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const makeAgentNode = (name: string, source: string, description: string): ResolvedAgentNode => ({
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
  subagents: []
});

const makeTeamNodeValue = (name: string, source: string, description: string): ResolvedTeamNode => ({
  auth: null,
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

const parseRoster = (yamlString: string): Roster => YAML.parse(yamlString) as Roster;

describe("generateTeamRosters", () => {
  const ROUTER_PORT = 9100;

  const makePlan = (agents: Array<{ name: string; source: string; description: string }>, teams?: Array<{ name: string; source: string; description: string }>): CompilePlan => ({
    edges: [],
    nodes: [
      ...agents.map((a) => ({
        id: `agent:${a.name}`,
        kind: "agent" as const,
        runtimeName: "openclaw",
        slug: a.name,
        value: makeAgentNode(a.name, a.source, a.description)
      })),
      ...(teams ?? []).map((t) => ({
        id: `team:${t.name}`,
        kind: "team" as const,
        runtimeName: null,
        slug: t.name,
        value: makeTeamNodeValue(t.name, t.source, t.description)
      }))
    ],
    root: "/project/Spawnfile",
    runtimes: { openclaw: { nodeIds: agents.map((a) => `agent:${a.name}`) } }
  });

  describe("hierarchical mode", () => {
    it("lead sees all members, non-lead sees only lead", () => {
      const teamNode: ResolvedTeamNode = {
        auth: null,
        description: "Test team",
        docs: [],
        external: [],
        kind: "team",
        lead: "alice",
        members: [
          { id: "alice", kind: "agent", nodeSource: "/project/alice/Spawnfile", runtimeName: "openclaw" },
          { id: "bob", kind: "agent", nodeSource: "/project/bob/Spawnfile", runtimeName: "openclaw" },
          { id: "carol", kind: "agent", nodeSource: "/project/carol/Spawnfile", runtimeName: "openclaw" }
        ],
        mode: "hierarchical",
        name: "engineering",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      const plan = makePlan([
        { name: "alice", source: "/project/alice/Spawnfile", description: "Team lead" },
        { name: "bob", source: "/project/bob/Spawnfile", description: "Backend dev" },
        { name: "carol", source: "/project/carol/Spawnfile", description: "Frontend dev" }
      ]);

      const rosters = generateTeamRosters(teamNode, plan, ROUTER_PORT);
      expect(rosters.size).toBe(3);

      const aliceRoster = parseRoster(rosters.get("alice")!);
      expect(aliceRoster.self).toBe("alice");
      expect(aliceRoster.members).toHaveLength(2);
      expect(aliceRoster.members.map((m) => m.name).sort()).toEqual(["bob", "carol"]);

      const bobRoster = parseRoster(rosters.get("bob")!);
      expect(bobRoster.self).toBe("bob");
      expect(bobRoster.members).toHaveLength(1);
      expect(bobRoster.members[0].name).toBe("alice");
      expect(bobRoster.members[0].role).toBe("lead");

      const carolRoster = parseRoster(rosters.get("carol")!);
      expect(carolRoster.members).toHaveLength(1);
      expect(carolRoster.members[0].name).toBe("alice");
    });
  });

  describe("swarm mode", () => {
    it("all members see all other members", () => {
      const teamNode: ResolvedTeamNode = {
        auth: null,
        description: "Swarm team",
        docs: [],
        external: [],
        kind: "team",
        lead: null,
        members: [
          { id: "alpha", kind: "agent", nodeSource: "/project/alpha/Spawnfile", runtimeName: "openclaw" },
          { id: "beta", kind: "agent", nodeSource: "/project/beta/Spawnfile", runtimeName: "openclaw" },
          { id: "gamma", kind: "agent", nodeSource: "/project/gamma/Spawnfile", runtimeName: "openclaw" }
        ],
        mode: "swarm",
        name: "research",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      const plan = makePlan([
        { name: "alpha", source: "/project/alpha/Spawnfile", description: "Researcher A" },
        { name: "beta", source: "/project/beta/Spawnfile", description: "Researcher B" },
        { name: "gamma", source: "/project/gamma/Spawnfile", description: "Researcher C" }
      ]);

      const rosters = generateTeamRosters(teamNode, plan, ROUTER_PORT);

      const alphaRoster = parseRoster(rosters.get("alpha")!);
      expect(alphaRoster.members).toHaveLength(2);
      expect(alphaRoster.members.map((m) => m.name).sort()).toEqual(["beta", "gamma"]);

      const betaRoster = parseRoster(rosters.get("beta")!);
      expect(betaRoster.members).toHaveLength(2);
      expect(betaRoster.members.map((m) => m.name).sort()).toEqual(["alpha", "gamma"]);
    });
  });

  describe("auth", () => {
    it("includes auth when team.auth is present", () => {
      const teamNode: ResolvedTeamNode = {
        auth: { mode: "shared_secret", secret: "TEAM_SECRET" },
        description: "Secure team",
        docs: [],
        external: [],
        kind: "team",
        lead: null,
        members: [
          { id: "a", kind: "agent", nodeSource: "/project/a/Spawnfile", runtimeName: "openclaw" },
          { id: "b", kind: "agent", nodeSource: "/project/b/Spawnfile", runtimeName: "openclaw" }
        ],
        mode: "swarm",
        name: "secure",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      const plan = makePlan([
        { name: "a", source: "/project/a/Spawnfile", description: "Agent A" },
        { name: "b", source: "/project/b/Spawnfile", description: "Agent B" }
      ]);

      const rosters = generateTeamRosters(teamNode, plan, ROUTER_PORT);
      const roster = parseRoster(rosters.get("a")!);

      expect(roster.auth).toEqual({ mode: "shared_secret", secret_env: "TEAM_SECRET" });
    });

    it("omits auth when team.auth is null", () => {
      const teamNode: ResolvedTeamNode = {
        auth: null,
        description: "Open team",
        docs: [],
        external: [],
        kind: "team",
        lead: null,
        members: [
          { id: "a", kind: "agent", nodeSource: "/project/a/Spawnfile", runtimeName: "openclaw" }
        ],
        mode: "swarm",
        name: "open",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      const plan = makePlan([
        { name: "a", source: "/project/a/Spawnfile", description: "Agent A" }
      ]);

      const rosters = generateTeamRosters(teamNode, plan, ROUTER_PORT);
      const roster = parseRoster(rosters.get("a")!);

      expect(roster.auth).toBeUndefined();
    });
  });

  describe("external flag", () => {
    it("sets external true when member is in teamNode.external", () => {
      const teamNode: ResolvedTeamNode = {
        auth: null,
        description: "Team with externals",
        docs: [],
        external: ["lead-agent"],
        kind: "team",
        lead: "lead-agent",
        members: [
          { id: "lead-agent", kind: "agent", nodeSource: "/project/lead/Spawnfile", runtimeName: "openclaw" },
          { id: "worker", kind: "agent", nodeSource: "/project/worker/Spawnfile", runtimeName: "openclaw" }
        ],
        mode: "hierarchical",
        name: "mixed",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      const plan = makePlan([
        { name: "lead-agent", source: "/project/lead/Spawnfile", description: "Lead" },
        { name: "worker", source: "/project/worker/Spawnfile", description: "Worker" }
      ]);

      const rosters = generateTeamRosters(teamNode, plan, ROUTER_PORT);

      const leadRoster = parseRoster(rosters.get("lead-agent")!);
      expect(leadRoster.external).toBe(true);

      const workerRoster = parseRoster(rosters.get("worker")!);
      expect(workerRoster.external).toBe(false);
    });
  });

  describe("description", () => {
    it("pulls description from member agent nodes in the plan", () => {
      const teamNode: ResolvedTeamNode = {
        auth: null,
        description: "Desc team",
        docs: [],
        external: [],
        kind: "team",
        lead: null,
        members: [
          { id: "writer", kind: "agent", nodeSource: "/project/writer/Spawnfile", runtimeName: "openclaw" },
          { id: "reviewer", kind: "agent", nodeSource: "/project/reviewer/Spawnfile", runtimeName: "openclaw" }
        ],
        mode: "swarm",
        name: "content",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      const plan = makePlan([
        { name: "writer", source: "/project/writer/Spawnfile", description: "Writes articles" },
        { name: "reviewer", source: "/project/reviewer/Spawnfile", description: "Reviews drafts" }
      ]);

      const rosters = generateTeamRosters(teamNode, plan, ROUTER_PORT);
      const writerRoster = parseRoster(rosters.get("writer")!);

      const reviewerEntry = writerRoster.members.find((m) => m.name === "reviewer");
      expect(reviewerEntry?.description).toBe("Reviews drafts");
    });
  });

  describe("nested team member", () => {
    it("gets role team for nested team members", () => {
      const teamNode: ResolvedTeamNode = {
        auth: null,
        description: "Parent team",
        docs: [],
        external: [],
        kind: "team",
        lead: "coordinator",
        members: [
          { id: "coordinator", kind: "agent", nodeSource: "/project/coord/Spawnfile", runtimeName: "openclaw" },
          { id: "sub-team", kind: "team", nodeSource: "/project/sub/Spawnfile", runtimeName: null }
        ],
        mode: "hierarchical",
        name: "org",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      const plan = makePlan(
        [{ name: "coordinator", source: "/project/coord/Spawnfile", description: "Coordinator agent" }],
        [{ name: "sub-team", source: "/project/sub/Spawnfile", description: "Sub-team for backend" }]
      );

      const rosters = generateTeamRosters(teamNode, plan, ROUTER_PORT);
      const coordRoster = parseRoster(rosters.get("coordinator")!);

      const subTeamEntry = coordRoster.members.find((m) => m.name === "sub-team");
      expect(subTeamEntry?.role).toBe("team");
      expect(subTeamEntry?.description).toBe("Sub-team for backend");
    });
  });

  describe("missing plan node", () => {
    it("returns empty description when member node is not found in plan", () => {
      const teamNode: ResolvedTeamNode = {
        auth: null,
        description: "Team",
        docs: [],
        external: [],
        kind: "team",
        lead: null,
        members: [
          { id: "known", kind: "agent", nodeSource: "/project/known/Spawnfile", runtimeName: "openclaw" },
          { id: "ghost", kind: "agent", nodeSource: "/project/ghost/Spawnfile", runtimeName: "openclaw" }
        ],
        mode: "swarm",
        name: "partial",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      // Only include "known" in the plan, not "ghost"
      const plan = makePlan([
        { name: "known", source: "/project/known/Spawnfile", description: "Known agent" }
      ]);

      const rosters = generateTeamRosters(teamNode, plan, ROUTER_PORT);
      const knownRoster = parseRoster(rosters.get("known")!);
      const ghostEntry = knownRoster.members.find((m) => m.name === "ghost");
      expect(ghostEntry?.description).toBe("");
    });
  });

  describe("endpoints", () => {
    it("uses the router port correctly in endpoints", () => {
      const teamNode: ResolvedTeamNode = {
        auth: null,
        description: "Endpoint team",
        docs: [],
        external: [],
        kind: "team",
        lead: null,
        members: [
          { id: "agent-x", kind: "agent", nodeSource: "/project/x/Spawnfile", runtimeName: "openclaw" },
          { id: "agent-y", kind: "agent", nodeSource: "/project/y/Spawnfile", runtimeName: "openclaw" }
        ],
        mode: "swarm",
        name: "endpoints",
        policyMode: null,
        policyOnDegrade: null,
        shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
        source: "/project/Spawnfile"
      };

      const plan = makePlan([
        { name: "agent-x", source: "/project/x/Spawnfile", description: "X" },
        { name: "agent-y", source: "/project/y/Spawnfile", description: "Y" }
      ]);

      const rosters = generateTeamRosters(teamNode, plan, 8080);
      const xRoster = parseRoster(rosters.get("agent-x")!);

      expect(xRoster.members[0].endpoint).toBe("http://localhost:8080/route/agent-y/v1/messages");
    });
  });
});
