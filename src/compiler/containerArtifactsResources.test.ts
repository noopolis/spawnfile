import { describe, expect, it } from "vitest";

import { openClawAdapter } from "../runtime/openclaw/adapter.js";

import { createContainerArtifacts } from "./containerArtifacts.js";
import type { MoltnetArtifacts } from "./moltnetArtifacts.js";
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

  // A workspace `kind: volume` is durable product state. Naming it from the
  // run id gave every `spawnfile run` a brand-new empty volume and silently
  // stranded the previous run's contents — the defect that destroyed a
  // newsroom's message history. The name must depend on the deployment
  // lineage and NOT on NOOPOLIS_RUN_ID.
  it("keeps writable workspace volume names stable across run ids and separate across deployments", async () => {
    const resource = { id: "edition", kind: "volume" as const, mode: "mutable" as const, mount: "./edition", scope: { kind: "team" as const, key: "/tmp/lab/Spawnfile", name: "lab" }, sharing: "team" as const };
    const agent = createAgentNode("writer", [resource]); const compiled = [{ emittedFiles: (await openClawAdapter.compileAgent(agent)).files, kind: "agent" as const, runtimeName: "openclaw", slug: agent.name, value: agent }];
    const previous = process.env.NOOPOLIS_RUN_ID; const names: string[] = [];
    try {
      for (const runId of ["live-r28", "candidate-r29"]) {
        process.env.NOOPOLIS_RUN_ID = runId;
        names.push((await createContainerArtifacts(createPlan(["openclaw"]), compiled, { deploymentLineage: "newsroom" })).report.workspace_resources![0]!.volume_name!);
      }
      process.env.NOOPOLIS_RUN_ID = "live-r28";
      const otherDeployment = (await createContainerArtifacts(createPlan(["openclaw"]), compiled, { deploymentLineage: "staging" })).report.workspace_resources![0]!.volume_name!;
      expect(otherDeployment).not.toBe(names[0]);
    }
    finally { if (previous === undefined) delete process.env.NOOPOLIS_RUN_ID; else process.env.NOOPOLIS_RUN_ID = previous; }
    expect(names[0]).toBe(names[1]);
    expect(names[0]).not.toContain("live-r28");
    expect(names[0]).not.toContain("candidate-r29");
  });

  it("honours an author-declared workspace volume name verbatim under any run id", async () => {
    // A live deployment reattaches hand-created volumes by exactly this name.
    const resource = { id: "edition-state", kind: "volume" as const, mode: "mutable" as const, mount: "./edition", name: "clank-edition-state", scope: { kind: "team" as const, key: "/tmp/lab/Spawnfile", name: "lab" }, sharing: "team" as const };
    const agent = createAgentNode("writer", [resource]); const compiled = [{ emittedFiles: (await openClawAdapter.compileAgent(agent)).files, kind: "agent" as const, runtimeName: "openclaw", slug: agent.name, value: agent }];
    const previous = process.env.NOOPOLIS_RUN_ID;
    try {
      for (const runId of ["live-r28", "candidate-r29"]) {
        process.env.NOOPOLIS_RUN_ID = runId;
        const result = await createContainerArtifacts(createPlan(["openclaw"]), compiled, { deploymentLineage: "newsroom" });
        expect(result.report.workspace_resources![0]!.volume_name).toBe("clank-edition-state");
        expect(result.report.persistent_mounts!.find((mount) => mount.id.startsWith("workspace-resource-"))!.lifecycle)
          .toBe("exclusive-reattach");
      }
    }
    finally { if (previous === undefined) delete process.env.NOOPOLIS_RUN_ID; else process.env.NOOPOLIS_RUN_ID = previous; }
  });

  // CALL-SITE lock for mergePersistentMounts. Its uniqueness check is unit
  // tested, but replacing the mergePersistentMounts(...) call in
  // containerArtifacts.ts with a plain sort left the whole suite green — a
  // correct helper that nothing proved was reached. This is the one collision
  // shape that ONLY the merge can catch: the two mounts come from two
  // independent sources (a workspace resource and a Moltnet store), so every
  // per-source check passes and they still claim one host volume at two paths.
  it("rejects a workspace resource and a Moltnet store that claim one volume name", async () => {
    const scope = { kind: "team" as const, key: "/tmp/lab/Spawnfile", name: "lab" };
    const agent = createAgentNode("reporter", [
      { id: "edition-state", kind: "volume" as const, mode: "mutable" as const, mount: "./edition", name: "clank-dup", scope, sharing: "team" as const }
    ]);
    const compiled = [{ emittedFiles: (await openClawAdapter.compileAgent(agent)).files, kind: "agent" as const, runtimeName: "openclaw", slug: agent.name, value: agent }];
    const moltnet = {
      files: [], nodePlans: [], ports: [], publishedPorts: [], serverPlans: [],
      persistentMounts: [{
        declaredVolumeName: "clank-dup",
        id: "moltnet-newsroom-store",
        lifecycle: "exclusive-reattach" as const,
        mountPath: "/var/lib/spawnfile/moltnet/networks/newsroom",
        reason: "managed Moltnet sqlite store for newsroom",
        volumeName: "clank-dup"
      }]
    } as unknown as MoltnetArtifacts;

    await expect(createContainerArtifacts(createPlan(["openclaw"]), compiled, { moltnet }))
      .rejects.toThrow(/claimed by two different mounts/u);
  });

  it("rejects two distinct resources whose declared names collapse onto one backing volume", async () => {
    // The backing path segment derives from an explicit `name`, so two
    // different resources declaring the same name silently shared one
    // directory and one volume, with both workspace symlinks pointing at it.
    const scope = { kind: "team" as const, key: "/tmp/lab/Spawnfile", name: "lab" };
    const analyst = createAgentNode("analyst", [
      { id: "edition-state", kind: "volume" as const, mode: "mutable" as const, mount: "./edition", name: "clank-dup", scope, sharing: "team" as const },
      { id: "morgue-state", kind: "volume" as const, mode: "mutable" as const, mount: "./morgue", name: "clank-dup", scope, sharing: "team" as const }
    ]);
    const compiled = [{ emittedFiles: (await openClawAdapter.compileAgent(analyst)).files, kind: "agent" as const, runtimeName: "openclaw", slug: analyst.name, value: analyst }];
    await expect(createContainerArtifacts(createPlan(["openclaw"]), compiled))
      .rejects.toThrow(/resolve to the same backing volume/u);
  });

  it("rejects incompatible team declarations that collide on one backing path", async () => {
    const resource = { id: "shared", kind: "volume" as const, mount: "./shared", scope: { kind: "team" as const, key: "/tmp/lab/Spawnfile", name: "lab" }, sharing: "team" as const };
    const analyst = createAgentNode("analyst", [{ ...resource, mode: "mutable" as const }]);
    const writer = createAgentNode("writer", [{ ...resource, mode: "readonly" as const }]);
    const compiled = await Promise.all([analyst, writer].map(async (value) => ({ emittedFiles: (await openClawAdapter.compileAgent(value)).files, kind: "agent" as const, runtimeName: "openclaw", slug: value.name, value })));
    await expect(createContainerArtifacts(createPlan(["openclaw"]), compiled)).rejects.toThrow(/incompatible mode, sharing, or owner/u);
  });
});
