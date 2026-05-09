import { describe, expect, it } from "vitest";

import { openClawAdapter } from "../runtime/openclaw/adapter.js";
import { tinyClawAdapter } from "../runtime/tinyclaw/adapter.js";

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

  it("mounts resources inside each TinyClaw agent working directory in merged targets", async () => {
    const sharedResource = {
      id: "dropbox",
      kind: "volume" as const,
      mode: "mutable" as const,
      mount: "./team-dropbox",
      scope: {
        kind: "team" as const,
        key: "/tmp/lab/Spawnfile",
        name: "lab"
      },
      sharing: "team" as const
    };
    const createTinyClawNode = (name: string): ResolvedAgentNode => ({
      description: "",
      docs: [],
      env: {},
      execution: undefined,
      kind: "agent",
      mcpServers: [],
      name,
      policyMode: null,
      policyOnDegrade: null,
      runtime: { name: "tinyclaw", options: {} },
      secrets: [],
      skills: [],
      source: `/tmp/tinyclaw/${name}/Spawnfile`,
      subagents: [],
      workspaceResources: [
        sharedResource,
        {
          id: "scratch",
          kind: "volume" as const,
          mode: "mutable" as const,
          mount: "./scratch",
          scope: {
            kind: "agent" as const,
            key: `/tmp/tinyclaw/${name}/Spawnfile`,
            name
          },
          sharing: "per_agent" as const
        }
      ]
    });
    const analyst = createTinyClawNode("analyst");
    const writer = createTinyClawNode("writer");
    const compiledAnalyst = await tinyClawAdapter.compileAgent(analyst);
    const compiledWriter = await tinyClawAdapter.compileAgent(writer);

    const result = await createContainerArtifacts(createPlan(["tinyclaw"]), [
      {
        emittedFiles: compiledAnalyst.files,
        kind: "agent",
        runtimeName: "tinyclaw",
        slug: "analyst",
        value: analyst
      },
      {
        emittedFiles: compiledWriter.files,
        kind: "agent",
        runtimeName: "tinyclaw",
        slug: "writer",
        value: writer
      }
    ]);

    const resources = result.report.workspace_resources ?? [];
    const links = resources.map((resource) => resource.link_path).sort();
    expect(links).toEqual([
      "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/workspace/analyst/scratch",
      "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/workspace/analyst/team-dropbox",
      "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/workspace/writer/scratch",
      "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/workspace/writer/team-dropbox"
    ]);

    const sharedBackings = resources
      .filter((resource) => resource.id === "dropbox")
      .map((resource) => resource.backing_path);
    const scratchBackings = resources
      .filter((resource) => resource.id === "scratch")
      .map((resource) => resource.backing_path);
    expect(new Set(sharedBackings).size).toBe(1);
    expect(new Set(scratchBackings).size).toBe(2);
  });
});
