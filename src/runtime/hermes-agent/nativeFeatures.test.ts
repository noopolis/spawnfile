import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode, ResolvedMemoryAccess } from "../../compiler/types.js";
import { resolveMnemeMcpMemoryWiring } from "../mnemeMcp.js";
import { buildHermesMcpConfig, hermesMcpEnvBindings, hermesMemoryCapability } from "./nativeFeatures.js";

const node: ResolvedAgentNode = {
  kind: "agent", name: "Test Agent", source: "agent.yml", description: "", env: {},
  execution: undefined, policyMode: null, policyOnDegrade: null, runtime: { name: "hermes-agent", options: {} },
  docs: [], skills: [], secrets: [], mcpServers: [], subagents: []
};

const notes: ResolvedMemoryAccess = {
  agentSource: node.source, source: node.source, declaringKind: "agent",
  bank: {
    id: "notes", declaredBy: "agent", declaredName: node.name, source: node.source,
    store: { kind: "sqlite", persistence: { mode: "durable", mount: "/mnt/notes" } },
    consolidation: { mode: "disabled" }, retention: { forgetting: "manual" },
    index: { graph: { enabled: false }, lexical: { enabled: true }, rerank: { enabled: false },
      vector: { enabled: false } }
  }
};

describe("Hermes MCP and Mneme lowering", () => {
  it("uses native transports, passes literal tool names and binds bearer headers at startup", () => {
    const agent: ResolvedAgentNode = { ...node, mcpServers: [
      { name: "local", transport: "stdio", command: "node", args: ["file with spaces.mjs"], env: { FLAG: "on" } },
      { name: "remote.http", transport: "streamable_http", url: "http://127.0.0.1/mcp",
        tools: ["read-notes", "search"], auth: { mode: "bearer", secret: "SYNTHETIC_MCP_TOKEN" } },
      { name: "remote.sse", transport: "sse", url: "http://127.0.0.1/sse" }
    ] };
    const config = buildHermesMcpConfig(agent);
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      local: { enabled: true, command: "node", args: ["file with spaces.mjs"], env: { FLAG: "on" },
        cwd: "<workspace-path>" },
      "remote.http": { enabled: true, transport: "streamable_http", url: "http://127.0.0.1/mcp",
        strict_redirect_headers: true, tools: { include: ["read-notes", "search"], resources: false, prompts: false } },
      "remote.sse": { enabled: true, transport: "sse", url: "http://127.0.0.1/sse" }
    });
    expect(hermesMcpEnvBindings(agent)).toEqual([{
      envName: "SYNTHETIC_MCP_TOKEN", jsonPath: ["mcp_servers", "remote.http", "headers", "Authorization"],
      transform: "bearer"
    }]);
  });

  it("refuses a wildcard allowlist, a remote process environment and ambiguous auth", () => {
    const remote = { name: "remote", transport: "sse", url: "http://127.0.0.1/sse" } as const;
    expect(() => buildHermesMcpConfig({ ...node, mcpServers: [{ ...remote, tools: ["read*"] }] }))
      .toThrow(/wildcard/);
    expect(() => buildHermesMcpConfig({ ...node, mcpServers: [{ ...remote, tools: ["${TOOL_NAME}"] }] }))
      .toThrow(/template syntax/);
    expect(() => buildHermesMcpConfig({ ...node, mcpServers: [{ ...remote, env: { FLAG: "on" } }] }))
      .toThrow(/remote process environment/);
    expect(() => buildHermesMcpConfig({ ...node, mcpServers: [{ ...remote, auth: { secret: "SYNTHETIC_TOKEN" } }] }))
      .toThrow(/explicit bearer/);
  });

  it("lowers awake Mneme against the durable mount and detects native name collisions", () => {
    const agent = { ...node, memoryAccess: [notes] };
    expect(buildHermesMcpConfig(agent)).toEqual({
      "mneme-notes": { enabled: true, command: "mneme", env: { NOOPOLIS_RUN_ID: "${NOOPOLIS_RUN_ID}" }, args: [
        "mcp", "--runtime-home", "/mnt/notes", "--agent-id", "test-agent", "--mode", "awake",
        "--source", "spawnfile:agent:notes"
      ] }
    });
    expect(resolveMnemeMcpMemoryWiring(notes.bank)).toEqual({ mountPath: "/mnt/notes", transport: "mcp" });
    expect(hermesMemoryCapability(agent).memoryOutcome).toBe("supported");
    expect(() => buildHermesMcpConfig({
      ...agent, mcpServers: [{ name: "mneme_notes", transport: "stdio", command: "node" }]
    })).toThrow(/overlaps a generated Mneme server/);
  });

  it("degrades unsupported stores and consolidation while preserving available awake MCP", () => {
    const scheduled = { ...notes, bank: { ...notes.bank, consolidation: { mode: "scheduled", schedule: "1h" } } } as const;
    const remote = { ...notes, bank: { ...notes.bank, store: { kind: "postgres" } } } as const;
    expect(hermesMemoryCapability({ ...node, memoryAccess: [scheduled] })).toMatchObject({
      memoryOutcome: "degraded", memoryMessage: expect.stringMatching(/consolidation/)
    });
    expect(Object.keys(buildHermesMcpConfig({ ...node, memoryAccess: [scheduled] }))).toEqual(["mneme-notes"]);
    expect(hermesMemoryCapability({ ...node, memoryAccess: [remote] }).memoryOutcome).toBe("degraded");
    expect(buildHermesMcpConfig({ ...node, memoryAccess: [remote] })).toEqual({});
  });
});
