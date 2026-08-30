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
    expect(new Set(resources.map((resource) => resource.volume_name)).size).toBe(1);
    expect(new Set(resources.map((resource) => resource.resolved_identity)).size).toBe(1);
    expect(resources.map((resource) => resource.link_path).sort()).toEqual([
      "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/workspace/shared",
      "/var/lib/spawnfile/instances/openclaw/agent-writer/home/.openclaw/workspace/shared"
    ]);
    expect(resources.every((resource) => resource.sharing === "team")).toBe(true);
    expect(resources.every((resource) => resource.replacement_sentinel?.result === "verified_on_startup")).toBe(true);
    expect((result.report.persistent_mounts ?? []).filter((mount) => mount.id.startsWith("workspace-resource-"))).toHaveLength(1);
  });

  it("keeps per-agent volume identities and names isolated", async () => {
    const resource = { id: "private", kind: "volume" as const, mode: "mutable" as const, mount: "./private", scope: { kind: "team" as const, key: "/tmp/lab/Spawnfile", name: "lab" }, sharing: "per_agent" as const };
    const agents = [createAgentNode("analyst", [resource]), createAgentNode("writer", [resource])];
    const compiled = await Promise.all(agents.map(async (value) => ({ emittedFiles: (await openClawAdapter.compileAgent(value)).files, kind: "agent" as const, runtimeName: "openclaw", slug: value.name, value })));
    const result = await createContainerArtifacts(createPlan(["openclaw"]), compiled);
    const resources = result.report.workspace_resources ?? [];
    expect(resources).toHaveLength(2);
    expect(new Set(resources.map((entry) => entry.backing_path)).size).toBe(2);
    expect(new Set(resources.map((entry) => entry.volume_name)).size).toBe(2);
    expect(new Set(resources.map((entry) => entry.resolved_identity)).size).toBe(2);
  });

  it("namespaces every writable workspace volume by candidate run", async () => {
    const resource = { id: "edition", kind: "volume" as const, mode: "mutable" as const, mount: "./edition", scope: { kind: "team" as const, key: "/tmp/lab/Spawnfile", name: "lab" }, sharing: "team" as const };
    const agent = createAgentNode("writer", [resource]); const compiled = [{ emittedFiles: (await openClawAdapter.compileAgent(agent)).files, kind: "agent" as const, runtimeName: "openclaw", slug: agent.name, value: agent }];
    const previous = process.env.NOOPOLIS_RUN_ID; const names: string[] = [];
    try { for (const runId of ["live-r28", "candidate-r29"]) { process.env.NOOPOLIS_RUN_ID = runId; names.push((await createContainerArtifacts(createPlan(["openclaw"]), compiled)).report.workspace_resources![0]!.volume_name!); } }
    finally { if (previous === undefined) delete process.env.NOOPOLIS_RUN_ID; else process.env.NOOPOLIS_RUN_ID = previous; }
    expect(names[0]).not.toBe(names[1]); expect(names).toEqual([expect.stringContaining("live-r28"), expect.stringContaining("candidate-r29")]);
  });

  it("rejects incompatible team declarations that collide on one backing path", async () => {
    const resource = { id: "shared", kind: "volume" as const, mount: "./shared", scope: { kind: "team" as const, key: "/tmp/lab/Spawnfile", name: "lab" }, sharing: "team" as const };
    const analyst = createAgentNode("analyst", [{ ...resource, mode: "mutable" as const }]);
    const writer = createAgentNode("writer", [{ ...resource, mode: "readonly" as const }]);
    const compiled = await Promise.all([analyst, writer].map(async (value) => ({ emittedFiles: (await openClawAdapter.compileAgent(value)).files, kind: "agent" as const, runtimeName: "openclaw", slug: value.name, value })));
    await expect(createContainerArtifacts(createPlan(["openclaw"]), compiled)).rejects.toThrow(/incompatible mode, sharing, or owner/u);
  });
});
