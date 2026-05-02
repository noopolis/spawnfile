import type { EmittedFile } from "../runtime/index.js";

import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedAgentSurfaces,
  ResolvedMemberRef,
  ResolvedTeamNetwork,
  ResolvedTeamNode
} from "./types.js";

export const createTestAgent = (
  name: string,
  source: string,
  surfaces?: ResolvedAgentSurfaces
): ResolvedAgentNode => ({
  description: `${name} description`,
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

export const createTestTeam = (input: {
  docs?: ResolvedTeamNode["docs"];
  external?: string[];
  externalExplicit?: boolean;
  lead?: string | null;
  members: ResolvedMemberRef[];
  mode?: "hierarchical" | "swarm";
  name: string;
  networks?: ResolvedTeamNetwork[];
  source: string;
}): ResolvedTeamNode => ({
  description: `${input.name} description`,
  docs: input.docs ?? [
    {
      content: `# ${input.name} operating context\n`,
      role: "system",
      sourcePath: `${input.source}/TEAM.md`
    }
  ],
  external: input.external ?? [],
  externalExplicit: input.externalExplicit ?? false,
  kind: "team",
  lead: input.lead ?? null,
  members: input.members,
  mode: input.mode ?? "swarm",
  name: input.name,
  networks: input.networks,
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: input.source
});

export const createTestPlan = (
  agents: ResolvedAgentNode[],
  teams: ResolvedTeamNode[],
  memberships: NonNullable<CompilePlan["memberships"]>
): CompilePlan => ({
  edges: [],
  memberships,
  nodes: [
    ...teams.map((team, index) => ({
      id: `team-${index}`,
      kind: "team" as const,
      runtimeName: null,
      slug: team.name.toLowerCase().replaceAll(" ", "-"),
      value: team
    })),
    ...agents.map((agent, index) => ({
      id: `agent-${index}`,
      kind: "agent" as const,
      runtimeName: agent.runtime.name,
      slug: agent.name,
      value: agent
    }))
  ],
  root: teams[0]?.source ?? agents[0]?.source ?? "/tmp/Spawnfile",
  runtimes: { openclaw: { nodeIds: agents.map((_, index) => `agent-${index}`) } }
});

export const findTestFile = (files: EmittedFile[], filePath: string): EmittedFile => {
  const file = files.find((entry) => entry.path === filePath);
  if (!file) {
    throw new Error(`missing emitted file ${filePath}`);
  }
  return file;
};
