import { describe, expect, it } from "vitest";

import { openClawAdapter } from "../runtime/openclaw/adapter.js";
import { daimonAdapter } from "../runtime/daimon/adapter.js";

import { createRuntimeTargetPlans } from "./containerArtifactsPlans.js";
import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";
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

  it("keeps an empty Daimon workspace in the one organization target", async () => {
    const node: ResolvedAgentNode = {
      ...createAgent(),
      runtime: { name: "daimon", options: { engine: "agy" } }
    };
    const compiled = await daimonAdapter.compileAgent(node);
    expect(compiled.files).toEqual([]);

    const priorRunId = process.env.NOOPOLIS_RUN_ID;
    process.env.NOOPOLIS_RUN_ID = "run-that-must-not-scope-the-host-realm";
    let result: Awaited<ReturnType<typeof createRuntimeTargetPlans>>;
    try {
      result = await createRuntimeTargetPlans({
        edges: [],
        nodes: [],
        root: "/tmp/Spawnfile",
        runtimes: { daimon: { nodeIds: [] } }
      }, [{
        emittedFiles: compiled.files,
        id: "agent:assistant",
        kind: "agent",
        runtimeName: "daimon",
        slug: "assistant",
        value: node
      }]);
    } finally {
      if (priorRunId === undefined) delete process.env.NOOPOLIS_RUN_ID;
      else process.env.NOOPOLIS_RUN_ID = priorRunId;
    }

    expect(result).toContainEqual(expect.objectContaining({
      engineByNodeId: { "agent:assistant": "agy" },
      id: "daimon-organization",
      modelAuthMethods: {},
      modelSecretsRequired: [],
      opaqueMountTargets: ["/var/lib/spawnfile/daimon/agy-unlock-secret"],
      persistentMounts: [
        {
          id: "daimon-agy-runtime-home-assistant",
          mount_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes/assistant",
          reason: "Daimon AGY subscription runtime home for agent:assistant",
          volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-agy-runtime-home-assistant")
        },
        {
          id: "daimon-agy-subscription-realm",
          mount_path: "/var/lib/spawnfile/daimon/agy-subscription-realm",
          reason: "Daimon host AGY subscription realm",
          volume_name: createPersistentVolumeName("/tmp/Spawnfile", "daimon-agy-subscription-realm")
        }
      ]
    }));
  });
});
