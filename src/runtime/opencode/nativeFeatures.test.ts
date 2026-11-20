import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode, ResolvedMemoryAccess } from "../../compiler/types.js";
import { buildOpenCodeMcpConfig, openCodeMcpCapabilities, openCodeMcpEnvBindings,
  openCodeMemoryCapability } from "./nativeFeatures.js";

const node: ResolvedAgentNode = {
  kind: "agent", name: "Test Agent", source: "agent.yml", description: "", env: {},
  execution: undefined, policyMode: null, policyOnDegrade: null, runtime: { name: "opencode", options: {} },
  docs: [], skills: [], secrets: [], mcpServers: [], subagents: []
};

const notes: ResolvedMemoryAccess = {
  agentSource: node.source, source: "team.yml", declaringKind: "team",
  bank: {
    id: "notes", declaredBy: "team", declaredName: "Test Team", source: "team.yml",
    store: { kind: "json", path: "/mnt/notes/memory.jsonl" },
    consolidation: { mode: "disabled" }, retention: { forgetting: "manual" },
    index: { graph: { enabled: false }, lexical: { enabled: true }, rerank: { enabled: false },
      vector: { enabled: false } }
  }
};

describe("OpenCode MCP and Mneme lowering", () => {
  it("lowers argv and headers, and reports negotiated remote transport", () => {
    const agent: ResolvedAgentNode = { ...node, mcpServers: [
      { name: "local", transport: "stdio", command: "node", args: ["file with spaces.mjs"], env: { FLAG: "on" } },
      { name: "remote.http", transport: "streamable_http", url: "http://127.0.0.1/mcp",
        auth: { mode: "bearer", secret: "SYNTHETIC_MCP_TOKEN" } },
      { name: "remote.sse", transport: "sse", url: "http://127.0.0.1/sse" }
    ] };
    expect(buildOpenCodeMcpConfig(agent)).toEqual({
      local: { type: "local", command: ["node", "file with spaces.mjs"], environment: { FLAG: "on" } },
      "remote.http": { type: "remote", url: "http://127.0.0.1/mcp", oauth: false },
      "remote.sse": { type: "remote", url: "http://127.0.0.1/sse", oauth: false }
    });
    expect(openCodeMcpEnvBindings(agent)).toEqual([{
      envName: "SYNTHETIC_MCP_TOKEN", jsonPath: ["mcp", "remote.http", "headers", "Authorization"], transform: "bearer"
    }]);
    expect(openCodeMcpCapabilities(agent)).toMatchObject([
      { key: "mcp.local", outcome: "supported" },
      { key: "mcp.remote.http", outcome: "degraded" },
      { key: "mcp.remote.sse", outcome: "degraded" }
    ]);
  });

  it("refuses exact tool allowlists and remote process environments the runtime cannot enforce", () => {
    const remote = { name: "remote", transport: "sse", url: "http://127.0.0.1/sse" } as const;
    expect(() => buildOpenCodeMcpConfig({ ...node, mcpServers: [{ ...remote, tools: ["read"] }] }))
      .toThrow(/allowlist/);
    expect(() => buildOpenCodeMcpConfig({ ...node, mcpServers: [{ ...remote, env: { FLAG: "on" } }] }))
      .toThrow(/remote process environment/);
    expect(() => buildOpenCodeMcpConfig({ ...node, mcpServers: [{ ...remote, auth: { secret: "SYNTHETIC_TOKEN" } }] }))
      .toThrow(/explicit bearer/);
  });

  it("lowers awake Mneme into native argv and degrades an unsupported store or consolidation", () => {
    const agent = { ...node, memoryAccess: [notes] };
    expect(buildOpenCodeMcpConfig(agent)).toEqual({
      "mneme-notes": { type: "local", command: [
        "mneme", "mcp", "--runtime-home", "/mnt/notes", "--agent-id", "test-agent",
        "--mode", "awake", "--source", "spawnfile:team:notes"
      ] }
    });
    expect(openCodeMemoryCapability(agent).memoryOutcome).toBe("supported");
    const remote = { ...notes, bank: { ...notes.bank, store: { kind: "postgres" } } } as const;
    expect(openCodeMemoryCapability({ ...node, memoryAccess: [remote] }).memoryOutcome).toBe("degraded");
    expect(buildOpenCodeMcpConfig({ ...node, memoryAccess: [remote] })).toEqual({});
    const scheduled = { ...notes, bank: { ...notes.bank, consolidation: { mode: "scheduled", schedule: "1h" } } } as const;
    expect(openCodeMemoryCapability({ ...node, memoryAccess: [scheduled] })).toMatchObject({
      memoryOutcome: "degraded", memoryMessage: expect.stringMatching(/consolidation/)
    });
    expect(Object.keys(buildOpenCodeMcpConfig({ ...node, memoryAccess: [scheduled] }))).toEqual(["mneme-notes"]);
  });
});
