import { describe, expect, it } from "vitest";

import type { MemoryBank } from "../manifest/index.js";

import {
  resolveDeclaredMemoryBanks,
  resolvePlanMemoryAccess
} from "./memoryResolution.js";
import type {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedMemoryBank,
  ResolvedTeamNode
} from "./types.js";

const bank = (
  id: string,
  overrides: Partial<MemoryBank> = {}
): MemoryBank => ({
  id,
  store: { kind: "memory" },
  ...overrides
});

const agent = (name: string): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name,
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "pi", options: {} },
  secrets: [],
  skills: [],
  source: `/org/${name}/Spawnfile`,
  subagents: []
});

const team = (members: ResolvedTeamNode["members"]): ResolvedTeamNode => ({
  description: "",
  docs: [],
  external: [],
  kind: "team",
  lead: null,
  members,
  mode: "swarm",
  name: "group",
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: "/org/Spawnfile"
});

const plan = (
  group: ResolvedTeamNode,
  agents: ResolvedAgentNode[]
): CompilePlan => ({
  edges: [],
  nodes: [
    { id: "team:group", kind: "team", runtimeName: null, slug: "group", value: group },
    ...agents.map((value) => ({
      id: `agent:${value.name}`,
      kind: "agent" as const,
      runtimeName: "pi",
      slug: value.name,
      value
    }))
  ],
  root: group.source,
  runtimes: {}
});

describe("memory resolution", () => {
  it("resolves defaults and every supported memory-store shape", () => {
    expect(resolveDeclaredMemoryBanks(undefined, "/org/Spawnfile", "team", "Group"))
      .toEqual([]);
    const resolved = resolveDeclaredMemoryBanks([
      bank("defaults"),
      bank("sqlite", {
        access: { members: ["alpha"] },
        consolidation: { mode: "scheduled", schedule: "6h", summarize_after_events: 50 },
        index: {
          graph: { enabled: true, kind: "entity_graph" },
          lexical: { enabled: false, engine: "sqlite_fts" },
          rerank: { enabled: true },
          vector: {
            base_url: "http://127.0.0.1:11434",
            dimensions: 768,
            enabled: true,
            model: "embedding-model",
            provider: "ollama",
            timeout_ms: 500
          }
        },
        retention: { forgetting: "ttl", ttl: "30d" },
        store: {
          kind: "sqlite",
          path: "/data/memory.sqlite",
          persistence: { mode: "durable", mount: "/data", name: "memory-data" }
        }
      }),
      bank("json", { store: { kind: "json" } }),
      bank("postgres", { store: { dsn_secret: "MEMORY_DSN", kind: "postgres" } })
    ], "/org/Spawnfile", "team", "Research Group");

    expect(resolved[0]).toMatchObject({
      consolidation: { mode: "disabled" },
      index: {
        graph: { enabled: false },
        lexical: { enabled: true },
        rerank: { enabled: false },
        vector: { enabled: false }
      },
      retention: { forgetting: "manual" },
      store: { kind: "memory" }
    });
    expect(resolved[1]).toMatchObject({
      access: { members: ["alpha"] },
      consolidation: { mode: "scheduled", schedule: "6h", summarize_after_events: 50 },
      index: {
        graph: { enabled: true, kind: "entity_graph" },
        lexical: { enabled: false, engine: "sqlite_fts" },
        vector: { dimensions: 768, model: "embedding-model", provider: "ollama", timeout_ms: 500 }
      },
      retention: { forgetting: "ttl", ttl: "30d" },
      store: {
        kind: "sqlite",
        path: "/data/memory.sqlite",
        persistence: { mode: "durable", mount: "/data", name: "memory-data" }
      }
    });
    expect(resolved[2]?.store).toEqual({
      kind: "json",
      path: "/var/lib/spawnfile/memory/research-group/json/memory.jsonl",
      persistence: { mode: "durable" }
    });
    expect(resolved[3]?.store).toEqual({ dsn_secret: "MEMORY_DSN", kind: "postgres" });
  });

  it("assigns private and shared banks, skips team members, and deduplicates access", () => {
    const alpha = agent("alpha");
    alpha.memory = resolveDeclaredMemoryBanks(
      [bank("private")],
      alpha.source,
      "agent",
      alpha.name
    );
    const group = team([
      { id: "alpha", kind: "agent", nodeSource: alpha.source, runtimeName: "pi" },
      { id: "nested", kind: "team", nodeSource: "/org/nested/Spawnfile", runtimeName: null }
    ]);
    group.memory = resolveDeclaredMemoryBanks([
      bank("shared"),
      bank("selected", { access: { members: ["alpha", "alpha", "nested"] } })
    ], group.source, "team", group.name);
    const current = plan(group, [alpha]);

    resolvePlanMemoryAccess(current);
    expect(current.memoryAccess).toHaveLength(3);
    expect(alpha.memoryAccess?.map((entry) => entry.bank.id).sort())
      .toEqual(["private", "selected", "shared"]);
    expect(alpha.memoryAccess?.find((entry) => entry.bank.id === "selected"))
      .toMatchObject({ declaringKind: "team", slotId: "alpha" });
  });

  it("leaves plans without banks unchanged and rejects unresolved member access", () => {
    const alpha = agent("alpha");
    const empty = plan(team([
      { id: "alpha", kind: "agent", nodeSource: alpha.source, runtimeName: "pi" }
    ]), [alpha]);
    resolvePlanMemoryAccess(empty);
    expect(empty.memoryAccess).toBeUndefined();

    const unknown = structuredClone(empty);
    const unknownTeam = unknown.nodes[0]!.value as ResolvedTeamNode;
    unknownTeam.memory = [{
      ...resolveDeclaredMemoryBanks([bank("shared")], unknownTeam.source, "team", unknownTeam.name)[0]!,
      access: { members: ["missing"] }
    }];
    expect(() => resolvePlanMemoryAccess(unknown)).toThrow(/unknown member missing/);

    const missingAgent = structuredClone(empty);
    const missingTeam = missingAgent.nodes[0]!.value as ResolvedTeamNode;
    missingTeam.members[0]!.nodeSource = "/org/absent/Spawnfile";
    missingTeam.memory = resolveDeclaredMemoryBanks(
      [bank("shared")],
      missingTeam.source,
      "team",
      missingTeam.name
    ) as ResolvedMemoryBank[];
    expect(() => resolvePlanMemoryAccess(missingAgent)).toThrow(/Unable to resolve agent member alpha/);
  });
});
