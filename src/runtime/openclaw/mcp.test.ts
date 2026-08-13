import { describe, expect, it } from "vitest";

import type {
  ResolvedAgentNode,
  ResolvedMemoryAccess,
  ResolvedMemoryBank
} from "../../compiler/types.js";

import { openClawAdapter } from "./adapter.js";
import {
  buildOpenClawAuthoredMcpServers,
  buildOpenClawMcpConfig,
  buildOpenClawMcpEnvBindings,
  openClawMemoryCapabilityFor
} from "./mcp.js";

const createNode = (overrides: Partial<ResolvedAgentNode> = {}): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: {
    model: {
      primary: {
        name: "claude-sonnet-4-5",
        provider: "anthropic"
      }
    }
  },
  kind: "agent",
  mcpServers: [],
  name: "assistant",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "openclaw", options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/agent/Spawnfile",
  subagents: [],
  ...overrides
});

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
  declaredName: "lab",
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

describe("OpenClaw MCP lowering", () => {
  it("maps authored stdio and remote MCP servers into OpenClaw mcp.servers", () => {
    const servers = [
      {
        args: ["server.js"],
        command: "node",
        env: { NODE_ENV: "test" },
        name: "local",
        transport: "stdio" as const
      },
      {
        auth: { secret: "SEARCH_API_KEY" },
        name: "search",
        transport: "streamable_http" as const,
        url: "https://search.example/mcp"
      },
      {
        name: "events",
        transport: "sse" as const,
        url: "https://events.example/sse"
      }
    ];

    expect(
      buildOpenClawAuthoredMcpServers(servers)
    ).toEqual({
      events: {
        enabled: true,
        transport: "sse",
        url: "https://events.example/sse"
      },
      local: {
        args: ["server.js"],
        command: "node",
        enabled: true,
        env: { NODE_ENV: "test" },
        transport: "stdio"
      },
      search: {
        enabled: true,
        headers: { SEARCH_API_KEY: "" },
        transport: "streamable-http",
        url: "https://search.example/mcp"
      }
    });
    expect(buildOpenClawMcpEnvBindings(servers)).toEqual([
      {
        envName: "SEARCH_API_KEY",
        jsonPath: ["mcp", "servers", "search", "headers", "SEARCH_API_KEY"]
      }
    ]);
  });

  it("serializes __proto__ as an authored bearer server with a structured binding", () => {
    const servers = [{
      auth: { mode: "bearer" as const, secret: "PROTO_TOKEN" },
      name: "__proto__",
      transport: "sse" as const,
      url: "https://example.test/mcp"
    }];
    const config = JSON.parse(JSON.stringify({ servers: buildOpenClawAuthoredMcpServers(servers) }));

    expect(Object.prototype.hasOwnProperty.call(config.servers, "__proto__")).toBe(true);
    expect(config.servers["__proto__"].headers).toEqual({ Authorization: "" });
    expect(buildOpenClawMcpEnvBindings(servers)).toEqual([{
      envName: "PROTO_TOKEN",
      jsonPath: ["mcp", "servers", "__proto__", "headers", "Authorization"],
      transform: "bearer"
    }]);
  });

  it("emits generated Mneme MCP servers for file-backed memory banks", async () => {
    const node = createNode({
      memoryAccess: [
        createAccess(createBank("shared", {
          kind: "sqlite",
          path: "/var/lib/spawnfile/memory/lab/shared/memory.sqlite",
          persistence: { mode: "durable" }
        }, {
          base_url: "http://127.0.0.1:11435",
          dimensions: 1024,
          enabled: true,
          model: "qwen3-embedding:0.6b",
          provider: "ollama",
          timeout_ms: 2500
        }))
      ]
    });
    const result = await openClawAdapter.compileAgent(node);
    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);

    expect(config.mcp.servers["mneme-shared"]).toEqual({
      args: [
        "mcp",
        "--runtime-home",
        "/var/lib/spawnfile/memory/lab/shared",
        "--agent-id",
        "assistant",
        "--mode",
        "awake",
        "--source",
        "spawnfile:team:shared",
        "--embedding-provider",
        "ollama",
        "--embedding-model",
        "qwen3-embedding:0.6b",
        "--embedding-base-url",
        "http://127.0.0.1:11435",
        "--embedding-dimensions",
        "1024",
        "--embedding-timeout-ms",
        "2500"
      ],
      command: "mneme",
      enabled: true
    });
    expect(result.capabilities).toContainEqual({
      key: "memory.shared",
      message: "OpenClaw accesses Mneme memory through generated MCP servers",
      outcome: "supported"
    });
  });

  it("emits a dream-mode Mneme MCP server for scheduled consolidation", async () => {
    const bank = {
      ...createBank("shared", {
        kind: "json",
        path: "/var/lib/spawnfile/memory/lab/shared/events.jsonl"
      }),
      consolidation: { mode: "scheduled" as const, schedule: "1h" }
    };
    const result = await openClawAdapter.compileAgent({
      ...createNode(),
      memoryAccess: [createAccess(bank)]
    });
    const config = JSON.parse(result.files.find((file) => file.path === "openclaw.json")!.content);

    expect(Object.keys(config.mcp.servers).sort()).toEqual(["mneme-shared", "mneme-shared-dream"]);
    expect(config.mcp.servers["mneme-shared"].args).toContain("awake");
    expect(config.mcp.servers["mneme-shared-dream"].args).toContain("dream");
  });

  it("does not emit dream-mode Mneme MCP servers for scheduled non-file stores", () => {
    const bank = {
      ...createBank("remote", {
        dsn_secret: "MEMORY_DSN",
        kind: "postgres"
      }),
      consolidation: { mode: "scheduled" as const, schedule: "1h" }
    };

    expect(buildOpenClawMcpConfig(createNode({ memoryAccess: [createAccess(bank)] }))).toBeUndefined();
  });

  it("disambiguates duplicate memory ids from different declaring manifests", () => {
    const first = createAccess(createBank("shared", {
      kind: "json",
      path: "/var/lib/spawnfile/memory/first/shared/events.jsonl"
    }));
    const second = createAccess(
      createBank("shared", {
        kind: "json",
        path: "/var/lib/spawnfile/memory/second/shared/events.jsonl"
      }, { enabled: false }, {
        declaredName: "second-lab",
        source: "/tmp/second/Spawnfile"
      }),
      "/tmp/second/Spawnfile"
    );
    const config = buildOpenClawMcpConfig(createNode({ memoryAccess: [first, second] }));
    const serverNames = Object.keys(config?.servers as Record<string, unknown>).sort();

    expect(serverNames).toHaveLength(2);
    expect(new Set(serverNames).size).toBe(2);
    expect(serverNames.every((name) => name.startsWith("mneme-shared-"))).toBe(true);
  });

  it("reports unsupported memory stores as degraded", () => {
    const node = createNode({
      memoryAccess: [
        createAccess(createBank("remote", {
          dsn_secret: "MEMORY_DSN",
          kind: "postgres"
        }))
      ]
    });

    expect(buildOpenClawMcpConfig(node)).toBeUndefined();
    expect(openClawMemoryCapabilityFor(node)).toEqual({
      message: "OpenClaw lowers file-backed Mneme memory through generated MCP servers; non-file stores are not lowered",
      outcome: "degraded"
    });
  });
});
