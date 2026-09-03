import { describe, expect, it } from "vitest";

import type { CompilePlan, ResolvedMemoryAccess, ResolvedMemoryBank } from "./types.js";
import { createMemoryArtifactBundle } from "./memoryArtifacts.js";
import { NOOPOLIS_RUN_ID_ENV } from "../runtime/common.js";
import { createExclusiveReattachVolumeName } from "../shared/index.js";

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

  it("reports direct transport for a daimon agent with a sqlite bank", () => {
    const daimonNode = createPlanNode("agent:daimon-agent", "daimon-agent", "daimon", "/tmp/daimon/Spawnfile");
    const bank = createBank("/tmp/daimon/Spawnfile", "shared", {
      kind: "sqlite",
      persistence: { mode: "durable" },
      path: "/var/lib/spawnfile/memory/daimon/shared/memory.sqlite"
    });

    const bundle = createMemoryArtifactBundle(
      createPlan([daimonNode], [
        { agentSource: daimonNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:daimon-agent": "direct"
    });
  });

  it("reports direct transport for a daimon agent with a json bank", () => {
    const daimonNode = createPlanNode("agent:daimon-agent", "daimon-agent", "daimon", "/tmp/daimon/Spawnfile");
    const bank = createBank("/tmp/daimon/Spawnfile", "shared", {
      kind: "json",
      persistence: { mode: "durable" },
      path: "/var/lib/spawnfile/memory/daimon/shared/memory.jsonl"
    });

    const bundle = createMemoryArtifactBundle(
      createPlan([daimonNode], [
        { agentSource: daimonNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:daimon-agent": "direct"
    });
  });

  it("reports unsupported transport for a daimon agent with a postgres bank", () => {
    const daimonNode = createPlanNode("agent:daimon-agent", "daimon-agent", "daimon", "/tmp/daimon/Spawnfile");
    const bank = createBank("/tmp/daimon/Spawnfile", "remote", {
      kind: "postgres",
      dsn_secret: "MEMORY_DSN"
    });

    const bundle = createMemoryArtifactBundle(
      createPlan([daimonNode], [
        { agentSource: daimonNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:daimon-agent": "unsupported"
    });
  });

  it("reports degraded transport for a pi agent with a memory-kind bank", () => {
    const piNode = createPlanNode("agent:pi-agent", "pi-agent", "pi", "/tmp/pi/Spawnfile");
    const bank = createBank("/tmp/pi/Spawnfile", "volatile", { kind: "memory" });

    const bundle = createMemoryArtifactBundle(
      createPlan([piNode], [
        { agentSource: piNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:pi-agent": "degraded"
    });
  });

  it("reports degraded transport for a daimon agent with a memory-kind bank", () => {
    const daimonNode = createPlanNode("agent:daimon-agent", "daimon-agent", "daimon", "/tmp/daimon/Spawnfile");
    const bank = createBank("/tmp/daimon/Spawnfile", "volatile", { kind: "memory" });

    const bundle = createMemoryArtifactBundle(
      createPlan([daimonNode], [
        { agentSource: daimonNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:daimon-agent": "degraded"
    });
  });

  it("reports degraded transport for an ephemeral sqlite bank, matching the mounts it emits", () => {
    // An ephemeral file-backed bank gets no durable volume and no daimon
    // memory block, so reporting `direct` would make the report disagree
    // with what was actually emitted.
    const daimonNode = createPlanNode("agent:daimon-agent", "daimon-agent", "daimon", "/tmp/daimon/Spawnfile");
    const piNode = createPlanNode("agent:pi-agent", "pi-agent", "pi", "/tmp/pi/Spawnfile");
    const bank = createBank("/tmp/daimon/Spawnfile", "scratch", {
      kind: "sqlite",
      persistence: { mode: "ephemeral" },
      path: "/tmp/scratch.sqlite"
    });

    const bundle = createMemoryArtifactBundle(
      createPlan([daimonNode, piNode], [
        { agentSource: daimonNode.value.source, declaringKind: "agent", source: bank.source, bank },
        { agentSource: piNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.mounts).toHaveLength(0);
    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:daimon-agent": "degraded",
      "agent:pi-agent": "degraded"
    });
  });

  it("reports degraded transport for a json bank with no resolvable mount path", () => {
    const daimonNode = createPlanNode("agent:daimon-agent", "daimon-agent", "daimon", "/tmp/daimon/Spawnfile");
    const bank = createBank("/tmp/daimon/Spawnfile", "pathless", { kind: "json" });

    const bundle = createMemoryArtifactBundle(
      createPlan([daimonNode], [
        { agentSource: daimonNode.value.source, declaringKind: "agent", source: bank.source, bank }
      ])
    );

    expect(bundle.mounts).toHaveLength(0);
    expect(bundle.memories[0]?.transport_by_node_id).toEqual({
      "agent:daimon-agent": "degraded"
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
        // Published in the distribution report so image mode honours it too.
        declared_volume_name: "journal-store",
        id: "memory-var-lib-spawnfile-persist-journal",
        lifecycle: "exclusive-reattach",
        mount_path: "/var/lib/spawnfile/persist/journal",
        reason: "durable memory stores under /var/lib/spawnfile/persist/journal",
        // An author-declared persistence.name is a request for a host-stable
        // volume identity, so it is honored verbatim rather than derived.
        volume_name: "journal-store"
      }
    ]);
    expect(bundle.mountPathMemoryMap.get("memory-var-lib-spawnfile-persist-journal")).toBe(
      "/var/lib/spawnfile/persist/journal"
    );
    expect(bundle.memories[0]?.store.persistent_mount_id).toBe("memory-var-lib-spawnfile-persist-journal");
  });

  /**
   * Mneme keys a store by its runtime home directory and discards the declared
   * filename, so two banks declaring different files in one directory are one
   * physical store with two writers. This used to compile silently, sharing the
   * mount between them.
   */
  it("rejects two distinct banks that resolve to the same durable directory", () => {
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

    expect(() => createMemoryArtifactBundle(
      createPlan([declaring], [
        { agentSource: declaring.value.source, declaringKind: "agent", source: first.source, bank: first },
        { agentSource: declaring.value.source, declaringKind: "agent", source: second.source, bank: second }
      ])
    )).toThrow(/both resolve to the durable memory directory \/var\/lib\/spawnfile\/memory\/assistant/u);
  });

  /**
   * The legitimate shape the guard must NOT reject: one bank declared twice, in
   * an org scope and again in a nested team scope, so agents on both sides of
   * the team boundary can reach it. `examples/daimon-org` ships exactly this.
   */
  it("shares one durable mount when the same bank is declared in two scopes", () => {
    const orgAgent = createPlanNode("agent:mapper", "mapper", "pi", "/tmp/pi/Spawnfile");
    const teamAgent = createPlanNode("agent:reviewer", "reviewer", "pi", "/tmp/pi/team/Spawnfile");
    const store = {
      kind: "json" as const,
      persistence: { mode: "durable" as const },
      path: "/var/lib/spawnfile/memory/org/shared-recall.jsonl"
    };
    const orgBank = createBank("/tmp/pi/Spawnfile", "shared-recall", store);
    const teamBank = createBank("/tmp/pi/team/Spawnfile", "shared-recall", store);

    const bundle = createMemoryArtifactBundle(
      createPlan([orgAgent, teamAgent], [
        { agentSource: orgAgent.value.source, declaringKind: "team", source: orgBank.source, bank: orgBank },
        { agentSource: teamAgent.value.source, declaringKind: "team", source: teamBank.source, bank: teamBank }
      ])
    );

    expect(bundle.mounts).toHaveLength(1);
    expect(bundle.memories.map((entry) => entry.store.persistent_mount_id)).toEqual([
      "memory-var-lib-spawnfile-memory-org",
      "memory-var-lib-spawnfile-memory-org"
    ]);
  });

  /**
   * A durable memory volume must survive a redeploy. Run-scoping it (the old
   * behavior) meant every `spawnfile up` mounted a fresh empty volume, so the
   * organization redeployed tomorrow remembered nothing.
   */
  it("names durable memory volumes by deployment lineage, not by run id", () => {
    const declaring = createPlanNode("agent:assistant", "assistant", "pi", "/tmp/pi/Spawnfile");
    const bank = createBank("/tmp/pi/Spawnfile", "journal", {
      kind: "sqlite",
      persistence: { mode: "durable" },
      path: "/var/lib/spawnfile/memory/assistant/journal.sqlite"
    });
    const access = [
      { agentSource: declaring.value.source, declaringKind: "agent" as const, source: bank.source, bank }
    ];
    const mountId = "memory-var-lib-spawnfile-memory-assistant";

    const withoutRunId = createMemoryArtifactBundle(createPlan([declaring], access), "production");
    process.env[NOOPOLIS_RUN_ID_ENV] = "run-aaaaaaaa";
    const withRunId = createMemoryArtifactBundle(createPlan([declaring], access), "production");
    delete process.env[NOOPOLIS_RUN_ID_ENV];

    expect(withoutRunId.mounts).toEqual([
      {
        id: mountId,
        lifecycle: "exclusive-reattach",
        mount_path: "/var/lib/spawnfile/memory/assistant",
        reason: "durable memory stores under /var/lib/spawnfile/memory/assistant",
        volume_name: createExclusiveReattachVolumeName("/tmp/pi/Spawnfile\u0000production", mountId)
      }
    ]);
    expect(withRunId.mounts).toEqual(withoutRunId.mounts);
    // A different deployment lineage is still a different volume.
    expect(
      createMemoryArtifactBundle(createPlan([declaring], access), "staging").mounts[0]?.volume_name
    ).not.toBe(withoutRunId.mounts[0]?.volume_name);
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
