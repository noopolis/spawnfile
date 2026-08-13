import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode, ResolvedMemoryAccess, ResolvedMemoryBank } from "../../compiler/types.js";

import { buildPicoClawMemoryMcpServers, picoClawMemoryCapabilityFor } from "./memory.js";

const createBank = (
  id: string,
  store: ResolvedMemoryBank["store"],
  vector: ResolvedMemoryBank["index"]["vector"] = {
    enabled: false
  },
  overrides: Partial<ResolvedMemoryBank> = {}
): ResolvedMemoryBank => ({
  consolidation: { mode: "disabled" },
  declaredBy: "team",
  declaredName: "team",
  id,
  index: {
    graph: { enabled: false },
    lexical: { enabled: true },
    rerank: { enabled: false },
    vector
  },
  retention: { forgetting: "manual" },
  source: "/tmp/team/Spawnfile",
  store,
  ...overrides
});

const createAccess = (
  bank: ResolvedMemoryBank,
  source = "/tmp/team/Spawnfile"
): ResolvedMemoryAccess => ({
  agentSource: "/tmp/agent/Spawnfile",
  bank,
  declaringKind: "team",
  slotId: "assistant",
  source
});

const createNode = (memoryAccess?: ResolvedMemoryAccess[]): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: {},
  kind: "agent",
  mcpServers: [],
  memoryAccess,
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "picoclaw", options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/agent/Spawnfile",
  subagents: []
});

describe("buildPicoClawMemoryMcpServers", () => {
  it("omits non-file-backed memory stores", () => {
    expect(buildPicoClawMemoryMcpServers(createNode())).toEqual({});
    expect(
      buildPicoClawMemoryMcpServers(createNode([
        createAccess(createBank("volatile", { kind: "memory" })),
        createAccess(createBank("remote", { kind: "postgres", dsn_secret: "POSTGRES_DSN" })),
        createAccess(createBank("missing-path", { kind: "sqlite", persistence: { mode: "ephemeral" } }))
      ]))
    ).toEqual({});
  });

  it("uses explicit persistence mounts before store paths", () => {
    const servers = buildPicoClawMemoryMcpServers(createNode([
      createAccess(createBank("shared", {
        kind: "sqlite",
        path: "/var/lib/spawnfile/memory/team/shared/memory.sqlite",
        persistence: {
          mode: "durable",
          mount: "/mnt/mneme/shared"
        }
      }))
    ]));

    expect(servers["mneme-shared"]?.args).toEqual([
      "mcp",
      "--runtime-home",
      "/mnt/mneme/shared",
	      "--agent-id",
	      "assistant",
	      "--mode",
	      "awake",
	      "--source",
      "spawnfile:team:shared"
    ]);
  });

  it("emits Ollama embedding arguments and suppresses duplicate bank sources", () => {
    const access = createAccess(createBank("shared", {
      kind: "json",
      path: "/var/lib/spawnfile/memory/team/shared/events.jsonl"
    }, {
      enabled: true,
      model: "nomic-embed-text",
      provider: "ollama"
    }));
    const servers = buildPicoClawMemoryMcpServers(createNode([access, access]));

    expect(Object.keys(servers)).toEqual(["mneme-shared"]);
    expect(servers["mneme-shared"]?.args).toContain("--embedding-provider");
    expect(servers["mneme-shared"]?.args).toContain("nomic-embed-text");
  });

  it("adds a dream-mode server when memory consolidation is scheduled", () => {
    const bank = {
      ...createBank("shared", {
        kind: "json",
        path: "/var/lib/spawnfile/memory/team/shared/events.jsonl"
      }),
      consolidation: { mode: "scheduled" as const, schedule: "1h" }
    };
    const servers = buildPicoClawMemoryMcpServers(createNode([createAccess(bank)]));

    expect(Object.keys(servers).sort()).toEqual(["mneme-shared", "mneme-shared-dream"]);
    expect(servers["mneme-shared"]?.args).toContain("awake");
    expect(servers["mneme-shared-dream"]?.args).toContain("dream");
  });

  it("does not add dream-mode servers for scheduled non-file stores", () => {
    const bank = {
      ...createBank("remote", {
        dsn_secret: "MEMORY_DSN",
        kind: "postgres"
      }),
      consolidation: { mode: "scheduled" as const, schedule: "1h" }
    };

    expect(buildPicoClawMemoryMcpServers(createNode([createAccess(bank)]))).toEqual({});
  });

  it("disambiguates duplicate memory ids from different declaring manifests", () => {
    const first = createAccess(createBank("shared", {
      kind: "json",
      path: "/var/lib/spawnfile/memory/team/shared/events.jsonl"
    }));
    const second = createAccess(
      createBank("shared", {
        kind: "json",
        path: "/var/lib/spawnfile/memory/second/shared/events.jsonl"
      }, { enabled: false }, {
        declaredName: "second-team",
        source: "/tmp/second/Spawnfile"
      }),
      "/tmp/second/Spawnfile"
    );
    const servers = buildPicoClawMemoryMcpServers(createNode([first, second]));
    const names = Object.keys(servers).sort();

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name.startsWith("mneme-shared-"))).toBe(true);
  });

  it("reports unsupported memory stores as degraded", () => {
    const node = createNode([
      createAccess(createBank("remote", {
        dsn_secret: "MEMORY_DSN",
        kind: "postgres"
      }))
    ]);

    expect(picoClawMemoryCapabilityFor(node)).toEqual({
      message: "PicoClaw lowers file-backed Mneme memory through generated MCP servers; non-file stores are not lowered",
      outcome: "degraded"
    });
  });

  it("does not emit embedding arguments for unsupported vector providers", () => {
    const servers = buildPicoClawMemoryMcpServers(createNode([
      createAccess(createBank("shared", {
        kind: "json",
        path: "/var/lib/spawnfile/memory/team/shared/events.jsonl"
      }, {
        enabled: true,
        model: "remote-embed",
        provider: "openai" as "ollama"
      }))
    ]));

    expect(servers["mneme-shared"]?.args).not.toContain("--embedding-provider");
  });

  it("falls back to stable names when ids or agent names slugify empty", () => {
    const servers = buildPicoClawMemoryMcpServers({
      ...createNode([
        createAccess(createBank("!!!", {
          kind: "sqlite",
          path: "/var/lib/spawnfile/memory/team/no-slug/memory.sqlite"
        }))
      ]),
      name: "!!!"
    });

    expect(servers["mneme-memory"]?.args).toContain("agent");
  });
});
