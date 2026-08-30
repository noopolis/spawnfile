import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDaimonUidEntrypointOwnershipPlan } from "../../compiler/containerDaimonUidEntrypointRender.js";
import { createMemoryArtifactBundle } from "../../compiler/memoryArtifacts.js";
import { resolveInstancePaths } from "../../compiler/containerTargetPlanResolution.js";
import type { RuntimeTargetPlan } from "../../compiler/containerArtifactsTypes.js";
import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedMemoryAccess,
  ResolvedMemoryBank
} from "../../compiler/types.js";
import { createPiTestNode } from "../pi/testHelpers.js";

import { daimonAdapter } from "./adapter.js";
import {
  createDaimonContainerTargets,
  DAIMON_CONFIG_FILE,
  DAIMON_INSTANCE_STATE_ROOT,
  DAIMON_ORGANIZATION_TARGET_ID
} from "./config.js";

const AGENT_SOURCE = "/tmp/agent/keeper/Spawnfile";
const TEAM_SOURCE = "/tmp/team/Spawnfile";

const createBank = (
  id: string,
  store: ResolvedMemoryBank["store"]
): ResolvedMemoryBank => ({
  consolidation: { mode: "disabled" },
  declaredBy: "team",
  declaredName: "lab",
  id,
  index: {
    graph: { enabled: false },
    lexical: { enabled: true },
    rerank: { enabled: false },
    vector: { enabled: false }
  },
  retention: { forgetting: "manual" },
  source: TEAM_SOURCE,
  store
});

const createAccess = (bank: ResolvedMemoryBank): ResolvedMemoryAccess => ({
  agentSource: AGENT_SOURCE,
  bank,
  declaringKind: "team",
  slotId: "keeper",
  source: TEAM_SOURCE
});

const createDaimonNode = (
  overrides: Partial<ResolvedAgentNode> = {}
): ResolvedAgentNode =>
  createPiTestNode({
    name: "Keeper",
    runtime: { name: "daimon", options: { engine: "codex" } },
    source: AGENT_SOURCE,
    ...overrides
  });

const emitConfig = async (node: ResolvedAgentNode): Promise<{
  agents: Array<Record<string, unknown>>;
}> => {
  const compiled = await daimonAdapter.compileAgent(node);
  const target = (await createDaimonContainerTargets([
    {
      emittedFiles: compiled.files,
      id: "agent:keeper",
      kind: "agent",
      slug: "keeper",
      value: node
    }
  ]))[0]!;
  return JSON.parse(
    target.files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content
  );
};

const memoryCapabilities = async (node: ResolvedAgentNode) =>
  (await daimonAdapter.compileAgent(node)).capabilities.filter((capability) =>
    capability.key === "memory" || capability.key.startsWith("memory."));

const createPlan = (node: ResolvedAgentNode, access: ResolvedMemoryAccess): CompilePlan => ({
  edges: [],
  memoryAccess: [access],
  nodes: [
    { id: "agent:keeper", kind: "agent", runtimeName: "daimon", slug: "keeper", value: node },
    {
      id: "team:lab",
      kind: "team",
      runtimeName: null,
      slug: "lab",
      value: {
        description: "",
        docs: [],
        kind: "team" as const,
        members: [],
        name: "lab",
        policyMode: null,
        policyOnDegrade: null,
        source: TEAM_SOURCE
      }
    }
  ] as unknown as CompilePlan["nodes"],
  root: AGENT_SOURCE,
  runtimes: { daimon: { nodeIds: ["agent:keeper"] } }
});

const createRuntimeTargetPlan = (): RuntimeTargetPlan => ({
  engineByNodeId: { "agent:keeper": "codex" },
  envFiles: [],
  id: "daimon-organization",
  instancePaths: resolveInstancePaths(
    "daimon",
    "daimon-organization",
    daimonAdapter.container
  ),
  meta: daimonAdapter.container,
  modelAuthMethods: {},
  modelSecretsRequired: [],
  port: daimonAdapter.container.port,
  recipeEnv: {},
  runtimeName: "daimon",
  runtimeRoot: "/opt/spawnfile/runtime-installs/daimon",
  sourceIds: ["agent:keeper"],
  targetFiles: []
});

describe("Daimon memory lowering", () => {
  const durableBank = createBank("shared", {
    kind: "sqlite",
    path: "/var/lib/spawnfile/memory/lab/shared/memory.sqlite",
    persistence: { mode: "durable" }
  });

  it("emits Daimon's memory block for a durably mounted file-backed bank", async () => {
    const node = createDaimonNode({ memoryAccess: [createAccess(durableBank)] });

    const config = await emitConfig(node);

    // Exactly Daimon's OrganizationRuntimeMemory shape: camelCase
    // runtimeHomePath plus the optional source discriminator. Daimon's parser
    // rejects unknown keys, so this must not grow Pi's snake_case fields.
    expect(config.agents[0]!.memory).toEqual({
      runtimeHomePath: "/var/lib/spawnfile/memory/lab/shared",
      source: "spawnfile:team:shared"
    });
  });

  it("points the memory block at a path the compiler durably mounts", async () => {
    const node = createDaimonNode({ memoryAccess: [createAccess(durableBank)] });
    const access = createAccess(durableBank);

    const config = await emitConfig(node);
    const bundle = createMemoryArtifactBundle(createPlan(node, access));

    // A runtime home with no persistent mount is either missing at container
    // start or root-owned (the Daimon UID entrypoint only chowns declared
    // mount paths), so Mneme's first write would fail. This is the durability
    // half of "supported".
    expect(bundle.mounts.map((mount) => mount.mount_path)).toContain(
      (config.agents[0]!.memory as { runtimeHomePath: string }).runtimeHomePath
    );
  });

  it("hands the memory mount to the Daimon UID ownership repair", async () => {
    const node = createDaimonNode({ memoryAccess: [createAccess(durableBank)] });
    const config = await emitConfig(node);
    const runtimeHomePath =
      (config.agents[0]!.memory as { runtimeHomePath: string }).runtimeHomePath;
    const bundle = createMemoryArtifactBundle(createPlan(node, createAccess(durableBank)));

    // The other half of durability: a fresh Docker volume is root-owned, and
    // Daimon's runtime runs as an unprivileged uid, so Mneme's first mkdir
    // under the emitted runtime home only succeeds because the memory mount
    // reaches the UID entrypoint's writable state roots.
    const ownership = resolveDaimonUidEntrypointOwnershipPlan(
      [createRuntimeTargetPlan()],
      bundle.mounts.map((mount) => mount.mount_path)
    );

    expect(ownership.stateRoots).toContain(runtimeHomePath);
  });

  it("keeps the memory runtime home isolated from the agent's own paths", async () => {
    const node = createDaimonNode({ memoryAccess: [createAccess(durableBank)] });
    const instancePaths = resolveInstancePaths(
      "daimon",
      "daimon-organization",
      daimonAdapter.container
    );

    const config = await emitConfig(node);
    const agent = config.agents[0]! as {
      memory: { runtimeHomePath: string };
      runtimeHomePath: string;
      workspacePath: string;
    };
    const resolve = (value: string) => value
      .replaceAll("<instance-root>", instancePaths.instanceRoot)
      .replaceAll("<workspace-path>", instancePaths.workspacePath);

    // Daimon's parser rejects a memory runtime home that overlaps the agent
    // workspace (a model-writable bash cwd) or any peer runtime home.
    for (const other of [resolve(agent.workspacePath), resolve(agent.runtimeHomePath)]) {
      expect(agent.memory.runtimeHomePath).not.toBe(other);
      expect(agent.memory.runtimeHomePath.startsWith(`${other}/`)).toBe(false);
      expect(other.startsWith(`${agent.memory.runtimeHomePath}/`)).toBe(false);
    }
  });

  it("reports memory as supported once the block is emitted", async () => {
    const node = createDaimonNode({ memoryAccess: [createAccess(durableBank)] });

    expect(await memoryCapabilities(node)).toEqual([
      {
        key: "memory",
        outcome: "supported",
        message: "Daimon lowers Mneme memory bank shared into the organization runtime agent config at /var/lib/spawnfile/memory/lab/shared"
      },
      {
        key: "memory.shared",
        outcome: "supported",
        message: "Daimon lowers Mneme memory bank shared into the organization runtime agent config at /var/lib/spawnfile/memory/lab/shared"
      }
    ]);
  });

  it("emits no memory block and degrades for a store with no durable volume", async () => {
    for (const store of [
      { kind: "memory" as const },
      { kind: "postgres" as const, dsn_secret: "MEMORY_DSN" },
      {
        kind: "sqlite" as const,
        path: "/var/lib/spawnfile/memory/lab/scratch/memory.sqlite",
        persistence: { mode: "ephemeral" as const }
      }
    ]) {
      const node = createDaimonNode({
        memoryAccess: [createAccess(createBank("scratch", store))]
      });

      expect((await emitConfig(node)).agents[0]!.memory).toBeUndefined();
      expect((await memoryCapabilities(node))[0]!.outcome).toBe("degraded");
    }
  });

  it("degrades when an agent declares more banks than Daimon can hold", async () => {
    const second = createBank("second", {
      kind: "sqlite",
      path: "/var/lib/spawnfile/memory/lab/second/memory.sqlite",
      persistence: { mode: "durable" }
    });
    const node = createDaimonNode({
      memoryAccess: [createAccess(durableBank), createAccess(second)]
    });

    const config = await emitConfig(node);

    expect(config.agents[0]!.memory).toEqual({
      runtimeHomePath: "/var/lib/spawnfile/memory/lab/second",
      source: "spawnfile:team:second"
    });
    expect((await memoryCapabilities(node))[0]!.outcome).toBe("degraded");
  });

  it("emits a compile diagnostic naming the wired bank and every ignored one", async () => {
    // Selection is the lexicographically first declared bank, so declaring a
    // bank that sorts earlier silently re-points the agent's memory home and
    // orphans the old bank's data. That has to be visible in the compile
    // diagnostics, not only as a capability row.
    const second = createBank("second", {
      kind: "sqlite",
      path: "/var/lib/spawnfile/memory/lab/second/memory.sqlite",
      persistence: { mode: "durable" }
    });
    const node = createDaimonNode({
      memoryAccess: [createAccess(durableBank), createAccess(second)]
    });

    const diagnostics = (await daimonAdapter.compileAgent(node)).diagnostics;
    const memoryDiagnostic = diagnostics.find((entry) => entry.message.includes("memory bank"));

    expect(memoryDiagnostic).toBeDefined();
    expect(memoryDiagnostic!.level).toBe("warn");
    expect(memoryDiagnostic!.message).toContain("second");
    expect(memoryDiagnostic!.message).toContain("shared");
  });

  it("emits no multi-bank diagnostic when only one bank is declared", async () => {
    const node = createDaimonNode({ memoryAccess: [createAccess(durableBank)] });
    const diagnostics = (await daimonAdapter.compileAgent(node)).diagnostics;
    expect(diagnostics.filter((entry) => entry.message.includes("memory bank"))).toEqual([]);
  });

  it("pins the instance-root guard to resolveInstancePaths, not a restated literal", () => {
    // The guard constant is the only thing keeping a declared memory store out
    // of the subtree Daimon's own container-side parser hard-rejects at boot.
    // Derive the expected root from the authority that actually builds those
    // paths so the two cannot drift apart silently.
    const instanceRoot = resolveInstancePaths(
      "daimon",
      DAIMON_ORGANIZATION_TARGET_ID,
      daimonAdapter.container
    ).instanceRoot;
    // resolveInstancePaths composes `<root>/<runtimeName>/<targetId>`.
    const derivedRoot = path.posix.dirname(path.posix.dirname(instanceRoot));

    expect(DAIMON_INSTANCE_STATE_ROOT).toBe(derivedRoot);
    expect(instanceRoot.startsWith(`${DAIMON_INSTANCE_STATE_ROOT}/`)).toBe(true);
  });

  it("rejects a memory store that overlaps the Daimon instance state root", async () => {
    const node = createDaimonNode({
      memoryAccess: [createAccess(createBank("collide", {
        kind: "sqlite",
        path: "/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/memory.sqlite",
        persistence: { mode: "durable" }
      }))]
    });

    await expect(emitConfig(node)).rejects.toThrow(/overlaps the Daimon instance state root/u);
  });

  /**
   * A bank asking for vector recall on a runtime that cannot do it must say so.
   * The emitted memory block carries no embedding configuration at all and
   * daimon's CLI harness never sets `memory.embeddingProvider`, so Mneme
   * silently falls back to lexical-only recall. Without this, the declaration
   * is accepted verbatim and quietly means something else.
   */
  it("warns that a bank declaring vector recall gets lexical-only recall", async () => {
    const vectorBank = createBank("shared", {
      kind: "sqlite",
      path: "/var/lib/spawnfile/memory/lab/shared/memory.sqlite",
      persistence: { mode: "durable" }
    });
    const node = createDaimonNode({
      memoryAccess: [createAccess({
        ...vectorBank,
        index: {
          ...vectorBank.index,
          vector: { enabled: true, model: "qwen3-embedding:0.6b", provider: "ollama" }
        }
      } as ResolvedMemoryBank)]
    });

    const compiled = await daimonAdapter.compileAgent(node);
    const config = await emitConfig(node);

    expect(compiled.diagnostics.map((diagnostic) => diagnostic.message)).toContainEqual(
      expect.stringContaining("Daimon organization runtime v1 has no vector recall")
    );
    expect(await memoryCapabilities(node)).toContainEqual(
      expect.objectContaining({ key: "memory", outcome: "degraded" })
    );
    // The warning is the whole fix: nothing about the emitted block changes.
    expect(config.agents[0]!.memory).toEqual({
      runtimeHomePath: "/var/lib/spawnfile/memory/lab/shared",
      source: "spawnfile:team:shared"
    });
  });

  it("stays silent about vector recall for a bank that never asked for it", async () => {
    const node = createDaimonNode({ memoryAccess: [createAccess(durableBank)] });
    const compiled = await daimonAdapter.compileAgent(node);

    expect(compiled.diagnostics.map((diagnostic) => diagnostic.message).join("\n"))
      .not.toContain("no vector recall");
    expect(await memoryCapabilities(node)).toContainEqual(
      expect.objectContaining({ key: "memory", outcome: "supported" })
    );
  });
});
