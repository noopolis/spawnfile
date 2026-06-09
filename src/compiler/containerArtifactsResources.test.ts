import { describe, expect, it } from "vitest";

import { openClawAdapter } from "../runtime/openclaw/adapter.js";

import { createContainerArtifacts } from "./containerArtifacts.js";
import type { CompilePlan, ResolvedAgentNode } from "./types.js";

const createPlan = (runtimeNames: string[]): CompilePlan => ({
  edges: [],
  nodes: [],
  root: "/tmp/Spawnfile",
  runtimes: Object.fromEntries(runtimeNames.map((runtimeName) => [runtimeName, { nodeIds: [] }]))
});

const createAgentNode = (
  name: string,
  workspaceResources: ResolvedAgentNode["workspaceResources"]
): ResolvedAgentNode => ({
  description: "",
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
  source: `/tmp/openclaw/${name}/Spawnfile`,
  subagents: [],
  workspaceResources
});

describe("container workspace resources", () => {
  it("uses one backing path for team-shared volumes and separate workspace links", async () => {
    const sharedResource = {
      id: "dropbox",
      kind: "volume" as const,
      mode: "mutable" as const,
      mount: "./shared",
      scope: {
        kind: "team" as const,
        key: "/tmp/lab/Spawnfile",
        name: "lab"
      },
      sharing: "team" as const
    };
    const analyst = createAgentNode("analyst", [sharedResource]);
    const writer = createAgentNode("writer", [sharedResource]);
    const compiledAnalyst = await openClawAdapter.compileAgent(analyst);
    const compiledWriter = await openClawAdapter.compileAgent(writer);

    const result = await createContainerArtifacts(createPlan(["openclaw"]), [
      {
        emittedFiles: compiledAnalyst.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "analyst",
        value: analyst
      },
      {
        emittedFiles: compiledWriter.files,
        kind: "agent",
        runtimeName: "openclaw",
        slug: "writer",
        value: writer
      }
    ]);

    const resources = result.report.workspace_resources ?? [];
    expect(resources).toHaveLength(2);
    expect(new Set(resources.map((resource) => resource.backing_path)).size).toBe(1);
    expect(resources.map((resource) => resource.link_path).sort()).toEqual([
      "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/workspace/shared",
      "/var/lib/spawnfile/instances/openclaw/agent-writer/home/.openclaw/workspace/shared"
    ]);
    expect(resources.every((resource) => resource.sharing === "team")).toBe(true);
  });
});
