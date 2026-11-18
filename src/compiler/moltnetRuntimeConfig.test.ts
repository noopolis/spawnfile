import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCompilePlan } from "./buildCompilePlan.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { createRuntimeReadinessWait } from "./containerRuntimeReadinessRender.js";
import { createMemoryArtifactBundle } from "./memoryArtifacts.js";
import { generateMoltnetArtifacts } from "./moltnetArtifacts.js";
import { assertMoltnetBridgeCapabilities } from "./moltnetBridgeCapabilities.js";
import { createMoltnetClientConfigFiles, resolveMoltnetWorkspaceLayout } from "./moltnetClientConfig.js";
import { createMoltnetBridgeConfigContent } from "./moltnetNodeConfig.js";
import { readTrustedMoltnetReleaseAuthority } from "./moltnetReleaseAuthority.js";
import { cleanTrainingProjects, trainingProject } from "./training/plan/fixtures.test-helper.js";
import type { ResolvedAgentNode } from "./types.js";
import { collectMoltnetWiringProbeObservations } from "../status/moltnetWiringProbes.js";

vi.mock("../runtime/registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../runtime/registry.js")>();
  const { createAcpStdioWiring, createMoltnetWorkspace } = await import("../runtime/portableMoltnetWiring.js");
  const base = original.getRuntimeAdapter("openclaw");
  const adapter: import("../runtime/types.js").RuntimeAdapter = {
    ...base,
    name: "fixture-fourth",
    assertSupportedSurfaces: undefined,
    container: {
      ...base.container,
      instancePaths: { ...base.container.instancePaths, workspacePathTemplate: "<instance-root>/workspace" }
    },
    wiring: {
      moltnet: {
        ...createAcpStdioWiring({
          command: "/opt/fixture-cli",
          args: ["acp", "--label", "argument with spaces", "$(literal)"],
          workspace: { ...createMoltnetWorkspace("codex", ["workspace/.agents/skills"]), installSkill: false }
        }),
        actorTokenScopes: ["attach", "observe", "write"]
      },
      memory: (bank) => ({ transport: "direct", mountPath: `/mnt/fixture/${bank.id}` }),
      readiness: { path: "/fixture-ready" }
    }
  };
  const hasFixtureAdapter = (name: string) => [adapter.name, "fixture-basic"].includes(name);
  return {
    ...original,
    assertRuntimeCanCompile: async (name: string) => hasFixtureAdapter(name)
      ? { ...await original.assertRuntimeCanCompile("openclaw"), name }
      : original.assertRuntimeCanCompile(name),
    getRuntimeAdapter: (name: string) => name === adapter.name ? adapter
      : name === "fixture-basic" ? { ...adapter, name, wiring: undefined }
      : original.getRuntimeAdapter(name),
    hasRuntimeAdapter: (name: string) => hasFixtureAdapter(name) || original.hasRuntimeAdapter(name),
    listRuntimeAdapters: () => [...original.listRuntimeAdapters(), adapter.name, "fixture-basic"]
  };
});

afterEach(cleanTrainingProjects);

const makeNetworkProject = (runtime: string) => trainingProject({
  Spawnfile: {
    spawnfile_version: "0.1", kind: "team", name: "scene", mode: "swarm",
    members: [{ id: "writer", ref: "writer" }],
    networks: [{
      id: "network", provider: "moltnet", rooms: [{ id: "room", members: ["writer"], visibility: "private" }],
      server: {
        mode: "managed", listen: { bind: "127.0.0.1", port: 18799 }, direct_messages: true,
        auth: {
          mode: "bearer", client: { token_id: "writer" },
          tokens: [{ id: "writer", secret: "WRITER_TOKEN", scopes: ["attach", "observe", "write"], agents: ["writer"] }]
        },
        store: { kind: "memory" }
      }
    }]
  },
  "writer/Spawnfile": {
    spawnfile_version: "0.1", kind: "agent", name: "Writer", runtime,
    memory: [{ id: "journal", store: { kind: "json", path: "/data/journal/events.jsonl" } }],
    surfaces: {
      moltnet: [{
        network: "network", rooms: { room: { wake: "mentions" } },
        dms: { enabled: true, wake: "all" }, auth: { token_id: "writer" }
      }]
    }
  }
});

describe("runtime adapter wiring", () => {
  it("emits workspace, node and bridge configs for a fourth name with literal ACP arguments", async () => {
    const plan = await buildCompilePlan(await makeNetworkProject("fixture-fourth"));
    const artifacts = (await generateMoltnetArtifacts(plan))!;
    const nodePlan = artifacts.nodePlans[0]!;
    const node = plan.nodes.find((entry) => entry.kind === "agent")!;
    const agentNode = node.value as ResolvedAgentNode;
    const serverPlan = artifacts.serverPlans[0]!;
    const config = artifacts.files.find((file) => file.path.endsWith(nodePlan.configPath))!;
    const attachment = JSON.parse(config.content).attachments[0];
    expect(attachment).toEqual({
      agent: { id: "writer", name: "Writer" },
      runtime: {
        kind: "acp", command: "/opt/fixture-cli", args: ["acp", "--label", "argument with spaces", "$(literal)"],
        workspace_path: `/var/lib/spawnfile/instances/fixture-fourth/agent-${node.slug}/workspace`
      },
      rooms: [{ id: "room", visibility: "private", wake: "mentions" }],
      dms: { enabled: true, wake: "all" }
    });
    expect(JSON.parse(config.content).moltnet.token_env).toBe("WRITER_TOKEN");
    expect(nodePlan).toMatchObject({ releaseCapability: "acp-bridge", credentialId: "writer" });

    const bridge = createMoltnetBridgeConfigContent({
      agentNode,
      attachment: { ...agentNode.surfaces!.moltnet![0]!, memberId: "writer" },
      networkServer: serverPlan.server,
      nodeSlug: node.slug,
      plan,
      serverPlan
    });
    expect(JSON.parse(bridge)).toEqual({
      version: "moltnet.bridge.v1",
      moltnet: JSON.parse(config.content).moltnet,
      ...attachment
    });
    expect(resolveMoltnetWorkspaceLayout("fixture-fourth", "Writer")).toMatchObject({
      cliRuntime: "codex", installSkill: false, skillPaths: ["workspace/.agents/skills/moltnet/SKILL.md"]
    });
    expect(createMoltnetClientConfigFiles(agentNode, artifacts)[0]).toMatchObject({
      path: "workspace/.moltnet/config.json",
      content: expect.stringContaining('"runtime": "fixture-fourth"')
    });
    expect(createMemoryArtifactBundle(plan)).toMatchObject({
      mounts: [{ mount_path: "/mnt/fixture/journal" }],
      memories: [{ transport_by_node_id: { [node.id]: "direct" } }]
    });
    expect(createRuntimeReadinessWait({ runtimeName: "fixture-fourth", port: 21800 } as RuntimeTargetPlan, "pid").join("\n"))
      .toContain("http://127.0.0.1:21800/fixture-ready");

    const authority = await readTrustedMoltnetReleaseAuthority();
    const published = { ...authority, ...authority.assets[0]!, version: "spawnfile.moltnet-release-identity.v1" } as const;
    expect(() => assertMoltnetBridgeCapabilities(artifacts.nodePlans, published)).toThrow(/acp-bridge capability \(network\)/u);
    expect(() => assertMoltnetBridgeCapabilities(artifacts.nodePlans, {
      ...published, capabilities: ["acp-bridge", "daimon-bridge", "pi-bridge"]
    })).not.toThrow();

    const observations = await collectMoltnetWiringProbeObservations({
      outputDirectory: "/fixture",
      readFile: async () => config.content,
      loadedReport: {
        kind: "loaded",
        reportPath: "/fixture/compile-report.json",
        report: {
          compileFingerprint: null,
          generatedAt: null,
          outputDirectory: "/fixture",
          reportPath: "/fixture/compile-report.json",
          root: null,
          moltnetNodePlans: [{ configPath: nodePlan.configPath, networkId: "network" }],
          moltnetServers: [],
          nodes: [],
          runtimeInstances: []
        }
      }
    });
    expect(observations.filter((entry) => entry.key === "network.wiring.control_url"))
      .toMatchObject([{ message: expect.stringContaining("acp runtime declares command /opt/fixture-cli") },
        { message: expect.stringContaining("acp runtime declares workspace_path") }]);
  });

  it("refuses requested features when a registered adapter omits them", async () => {
    await expect(buildCompilePlan(await makeNetworkProject("fixture-basic")))
      .rejects.toThrow(/Writer selects runtime fixture-basic, which has no Moltnet wiring capability/u);
    const root = await trainingProject({
      Spawnfile: { spawnfile_version: "0.1", kind: "agent", name: "Solo", runtime: "fixture-basic",
        memory: [{ id: "journal", store: { kind: "memory" } }] }
    });
    await expect(buildCompilePlan(root)).rejects.toThrow(/Solo selects runtime fixture-basic, which has no memory wiring capability/u);
  });
});
