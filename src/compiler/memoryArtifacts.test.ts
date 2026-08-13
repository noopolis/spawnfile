import { describe, expect, it } from "vitest";

import type { CompilePlan, ResolvedMemoryAccess, ResolvedMemoryBank } from "./types.js";
import { createMemoryArtifactBundle } from "./memoryArtifacts.js";
import { createPersistentVolumeName } from "./moltnetArtifactPaths.js";

const baseMemoryIndex = {
  graph: { enabled: false },
  lexical: { enabled: true },
  rerank: { enabled: false },
  vector: { enabled: false }
};

const baseMemoryRetention = { forgetting: "manual" as const };
const baseMemoryConsolidation = { mode: "disabled" as const };

const createResolvedAgentNode = (
  id: string,
  source: string,
  runtimeName: string,
  runtimeOptions: Record<string, unknown> = {}
) => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent" as const,
  mcpServers: [],
  name: id.split(":")[1] ?? "agent",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: runtimeName, options: runtimeOptions },
  secrets: [],
  skills: [],
  source,
  subagents: []
});

const createPlanNode = (
  id: string,
  slug: string,
  runtimeName: string,
  source: string,
  runtimeOptions: Record<string, unknown> = {}
) =>
  ({
    id,
    kind: "agent",
    runtimeName,
    slug,
    value: createResolvedAgentNode(id, source, runtimeName, runtimeOptions)
  } as const);

const createPlan = (nodes: CompilePlan["nodes"], memoryAccess: ResolvedMemoryAccess[]): CompilePlan => {
  const runtimeNames = [...new Set(nodes.map((node) => node.runtimeName)
    .filter((runtimeName): runtimeName is string => runtimeName !== null))];

  return {
    edges: [],
    memoryAccess,
    nodes,
    root: nodes[0]?.value.source ?? "/tmp/Spawnfile",
    runtimes: Object.fromEntries(runtimeNames.map((runtimeName) => [runtimeName, { nodeIds: [] }]))
  };
};

const createBank = (
  declaringSource: string,
  id: string,
  store: ResolvedMemoryBank["store"]
): ResolvedMemoryBank => ({
  access: undefined,
  consolidation: baseMemoryConsolidation,
  declaredBy: "agent",
  declaredName: "agent manifest",
  id,
  index: baseMemoryIndex,
  retention: baseMemoryRetention,
  source: declaringSource,
  store
});

describe("createMemoryArtifactBundle", () => {
  it("maps transport by runtime name", () => {
    const piNode = createPlanNode("agent:pi-agent", "pi-agent", "pi", "/tmp/pi/Spawnfile");
    const picoclawNode = createPlanNode("agent:mcp-agent", "mcp-agent", "picoclaw", "/tmp/picoclaw/Spawnfile");
    const openclawNode = createPlanNode("agent:openclaw-agent", "openclaw-agent", "openclaw", "/tmp/openclaw/Spawnfile");
    const unknownNode = createPlanNode("agent:unsupported-agent", "unsupported-agent", "other-runtime", "/tmp/other/Spawnfile");

    const bank = createBank("/tmp/pi/Spawnfile", "shared", {
      kind: "sqlite",
      persistence: { mode: "durable" },
      path: "/var/lib/spawnfile/memory/pi/shared/memory.sqlite"
    });

    const memoryAccess: ResolvedMemoryAccess[] = [
      { agentSource: piNode.value.source, declaringKind: "agent", source: bank.source, bank },
      { agentSource: picoclawNode.value.source, declaringKind: "agent", source: bank.source, bank },
      { agentSource: openclawNode.value.source, declaringKind: "agent", source: bank.source, bank },
      { agentSource: unknownNode.value.source, declaringKind: "agent", source: bank.source, bank }
    ];

    const bundle = createMemoryArtifactBundle(
      createPlan([piNode, picoclawNode, openclawNode, unknownNode], memoryAccess)
    );

    expect(bundle.memories).toHaveLength(1);
    expect(bundle.memories[0]).toMatchObject({
      id: "shared",
      declaring_node_id: "agent:pi-agent",
      accessible_node_ids: [
        "agent:mcp-agent",
        "agent:openclaw-agent",
        "agent:pi-agent",
        "agent:unsupported-agent"
      ],
      transport_by_node_id: {
        "agent:pi-agent": "direct",
        "agent:mcp-agent": "mcp",
        "agent:openclaw-agent": "mcp",
        "agent:unsupported-agent": "unsupported"
      }
    });
  });

  it("reports MCP runtimes as degraded for non-file-backed memory stores", () => {
    const picoclawNode = createPlanNode("agent:pico", "pico", "picoclaw", "/tmp/picoclaw/Spawnfile");
    const openclawNode = createPlanNode("agent:open", "open", "openclaw", "/tmp/openclaw/Spawnfile");
    const bank = createBank("/tmp/picoclaw/Spawnfile", "remote", {
      dsn_secret: "MEMORY_DSN",
      kind: "postgres"
    });

    const bundle = createMemoryArtifactBundle(
      createPlan([picoclawNode, openclawNode], [
        { agentSource: picoclawNode.value.source, declaringKind: "agent", source: bank.source, bank },
        { agentSource: openclawNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:open": "degraded_mcp",
      "agent:pico": "degraded_mcp"
    });
  });

  it("reports CLI-backed Daimon engines as direct memory transports", () => {
    const piNode = createPlanNode(
      "agent:codex-agent",
      "codex-agent",
      "pi",
      "/tmp/pi/Spawnfile",
      { engine: "codex" }
    );
    const bank = createBank("/tmp/pi/Spawnfile", "shared", {
      kind: "sqlite",
      persistence: { mode: "durable" },
      path: "/var/lib/spawnfile/memory/pi/shared/memory.sqlite"
    });

    const bundle = createMemoryArtifactBundle(
      createPlan([piNode], [
        { agentSource: piNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:codex-agent": "direct"
    });
  });

  it("adds durable sqlite mounts and mount IDs", () => {
    const declaring = createPlanNode("agent:assistant", "assistant", "pi", "/tmp/pi/Spawnfile");
    const bank = createBank("/tmp/pi/Spawnfile", "journal", {
      kind: "sqlite",
      persistence: {
        mode: "durable",
        mount: "/var/lib/spawnfile/persist/journal",
        name: "journal-store"
      },
      path: "/var/lib/spawnfile/personal/assistant/journal/memory.sqlite"
    });
    const bundle = createMemoryArtifactBundle(
      createPlan([declaring], [
        { agentSource: declaring.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.mounts).toEqual([
      {
        id: "memory-var-lib-spawnfile-persist-journal",
        mount_path: "/var/lib/spawnfile/persist/journal",
        reason: "durable memory stores under /var/lib/spawnfile/persist/journal",
        volume_name: "journal-store"
      }
    ]);
    expect(bundle.mountPathMemoryMap.get("memory-var-lib-spawnfile-persist-journal")).toBe(
      "/var/lib/spawnfile/persist/journal"
    );
    expect(bundle.memories[0]?.store.persistent_mount_id).toBe("memory-var-lib-spawnfile-persist-journal");
  });

  it("shares one durable mount for multiple memory files in the same directory", () => {
    const declaring = createPlanNode("agent:assistant", "assistant", "pi", "/tmp/pi/Spawnfile");
    const first = createBank("/tmp/pi/Spawnfile", "journal", {
      kind: "sqlite",
      persistence: { mode: "durable" },
      path: "/var/lib/spawnfile/memory/assistant/journal.sqlite"
    });
    const second = createBank("/tmp/pi/Spawnfile", "notes", {
      kind: "json",
      persistence: { mode: "durable" },
      path: "/var/lib/spawnfile/memory/assistant/notes.jsonl"
    });
    const bundle = createMemoryArtifactBundle(
      createPlan([declaring], [
        { agentSource: declaring.value.source, declaringKind: "agent", source: first.source, bank: first },
        { agentSource: declaring.value.source, declaringKind: "agent", source: second.source, bank: second }
      ])
    );

    expect(bundle.mounts).toHaveLength(1);
    expect(bundle.mounts[0]).toEqual({
      id: "memory-var-lib-spawnfile-memory-assistant",
      mount_path: "/var/lib/spawnfile/memory/assistant",
      reason: "durable memory stores under /var/lib/spawnfile/memory/assistant",
      // Now project-scoped via createPersistentVolumeName (plan.root, here
      // "/tmp/pi/Spawnfile") rather than a bare path slug, so two different
      // projects sharing this mount-path convention no longer collide on
      // the same host docker volume. No NOOPOLIS_RUN_ID is set in this test
      // process env, so no run segment is folded in.
      volume_name: createPersistentVolumeName(
        "/tmp/pi/Spawnfile",
        "memory-var-lib-spawnfile-memory-assistant"
      )
    });
    expect(bundle.memories.map((entry) => entry.store.persistent_mount_id)).toEqual([
      "memory-var-lib-spawnfile-memory-assistant",
      "memory-var-lib-spawnfile-memory-assistant"
    ]);
  });

  it("skips durable mounts for ephemeral sqlite/json stores and non-file stores", () => {
    const piNode = createPlanNode("agent:assistant", "assistant", "pi", "/tmp/pi/Spawnfile");

    const sqliteEphemeral = createBank("/tmp/pi/Spawnfile", "chat", {
      kind: "sqlite",
      persistence: { mode: "ephemeral" },
      path: "/tmp/chat.sqlite"
    });
    const memoryOnly = createBank("/tmp/pi/Spawnfile", "volatile", { kind: "memory" });
    const postgres = createBank("/tmp/pi/Spawnfile", "remote", {
      kind: "postgres",
      dsn_secret: "PG_DSN"
    });

    const bundle = createMemoryArtifactBundle(
      createPlan([piNode], [
        {
          agentSource: piNode.value.source,
          declaringKind: "agent",
          source: piNode.value.source,
          bank: sqliteEphemeral
        },
        {
          agentSource: piNode.value.source,
          declaringKind: "agent",
          source: piNode.value.source,
          bank: memoryOnly
        },
        {
          agentSource: piNode.value.source,
          declaringKind: "agent",
          source: piNode.value.source,
          bank: postgres
        }
      ])
    );

    expect(bundle.mounts).toHaveLength(0);
    expect(bundle.memories).toHaveLength(3);
    expect(bundle.memories.map((entry) => entry.id).sort()).toEqual(["chat", "remote", "volatile"]);
    expect(bundle.memories.map((entry) => entry.store)).toEqual([
      {
        kind: "sqlite",
        persistence: "ephemeral",
        path: "/tmp/chat.sqlite"
      },
      { kind: "postgres", dsn_secret: "PG_DSN" },
      { kind: "memory" }
    ]);
  });
});
