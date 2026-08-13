import { describe, expect, it } from "vitest";

import { openClawAdapter } from "../runtime/openclaw/adapter.js";

import { createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const createAgent = (): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/assistant/Spawnfile",
  subagents: []
});

const createTeam = (): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  kind: "team",
  lead: null,
  members: [],
  mode: "swarm",
  name: "group",
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: "/tmp/group/Spawnfile"
});

describe("runtime target plan source identity", () => {
  it("derives an omitted compiled-node id from its kind and slug", async () => {
    const node = createAgent();
    const compiled = await openClawAdapter.compileAgent(node);
    const plan: CompilePlan = {
      edges: [],
      nodes: [],
      root: "/tmp/Spawnfile",
      runtimes: { openclaw: { nodeIds: [] } }
    };
    const result = await createRuntimeTargetPlans(plan, [
      {
        emittedFiles: compiled.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "assistant",
        value: node
      },
      {
        emittedFiles: [{ content: "{}\n", path: "openclaw.json" }],
        kind: "team",
        runtimeName: "openclaw",
        slug: "group",
        value: createTeam()
      }
    ]);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual(expect.objectContaining({
      id: "agent-assistant",
      sourceIds: ["agent:assistant"]
    }));
    expect(result).toContainEqual(expect.objectContaining({
      id: "team-group",
      sourceIds: ["team:group"]
    }));
  });
});
