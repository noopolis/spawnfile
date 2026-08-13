import { describe, expect, it } from "vitest";

import { resolvePlanMoltnetAttachments } from "./moltnetResolution.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const createAgent = (source: string): ResolvedAgentNode => ({
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
  source,
  surfaces: { moltnet: [{ memberId: null, network: "org", teamSource: null }] },
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

describe("Moltnet external participant resolution", () => {
  it("uses canonical nested member ids in B31 while preserving legacy collision checks", () => {
    const makeTeam = (source: string, agentSource: string): ResolvedTeamNode => createTeam({
      members: [{ id: "red", kind: "agent", nodeSource: agentSource, runtimeName: "openclaw" }],
      networks: [{ id: "org", name: "Org", provider: "moltnet", rooms: [] }],
      source
    });
    const alpha = makeTeam("/tmp/alpha/Spawnfile", "/tmp/alpha/red/Spawnfile");
    const beta = makeTeam("/tmp/beta/Spawnfile", "/tmp/beta/red/Spawnfile");
    const root = createTeam({
      members: [
        { id: "alpha", kind: "team", nodeSource: alpha.source, runtimeName: null },
        { id: "beta", kind: "team", nodeSource: beta.source, runtimeName: null }
      ],
      source: "/tmp/root/Spawnfile"
    });
    const b31: CompilePlan = {
      edges: [
        { from: "root", kind: "team_member", label: "alpha", to: "alpha" },
        { from: "root", kind: "team_member", label: "beta", to: "beta" },
        { from: "alpha", kind: "team_member", label: "red", to: "alpha-agent" },
        { from: "beta", kind: "team_member", label: "red", to: "beta-agent" }
      ],
      memberships: [
        { agentSource: "/tmp/alpha/red/Spawnfile", memberId: "red", teamName: "alpha", teamSource: alpha.source },
        { agentSource: "/tmp/beta/red/Spawnfile", memberId: "red", teamName: "beta", teamSource: beta.source }
      ],
      moltnetRoomMemberships: [],
      nodes: [
        { id: "root", kind: "team", runtimeName: null, slug: "root", value: root },
        { id: "alpha", kind: "team", runtimeName: null, slug: "alpha", value: alpha },
        { id: "beta", kind: "team", runtimeName: null, slug: "beta", value: beta },
        { id: "alpha-agent", kind: "agent", runtimeName: "openclaw", slug: "alpha-red", value: createAgent("/tmp/alpha/red/Spawnfile") },
        { id: "beta-agent", kind: "agent", runtimeName: "openclaw", slug: "beta-red", value: createAgent("/tmp/beta/red/Spawnfile") }
      ],
      organizationIdentity: {
        agentMembers: [
          { authoredMemberKey: "red", kind: "agent", memberId: "alpha.red", principalId: "agent:alpha.red" },
          { authoredMemberKey: "red", kind: "agent", memberId: "beta.red", principalId: "agent:beta.red" }
        ],
        externalParticipants: []
      },
      root: root.source,
      runtimes: {}
    };
    expect(() => resolvePlanMoltnetAttachments(b31)).not.toThrow();

    const legacy = { ...b31, edges: [], organizationIdentity: undefined };
    expect(() => resolvePlanMoltnetAttachments(legacy)).toThrow(/member_id red/u);
  });
});
