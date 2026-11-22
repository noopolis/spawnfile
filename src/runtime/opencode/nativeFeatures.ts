import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { McpServer } from "../../manifest/index.js";
import type { CapabilityReport } from "../../report/index.js";
import { SpawnfileError } from "../../shared/index.js";
import {
  buildMnemeMemoryMcpServers, hasUnsupportedMnemeMemoryAccess
} from "../mnemeMcp.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";

export function assertOpenCodeMcp(node: ResolvedAgentNode): void {
  for (const server of node.mcpServers) {
    const fail = (reason: string): never => {
      throw new SpawnfileError("validation_error", `OpenCode MCP server ${server.name} ${reason}`);
    };
    if (server.tools) {
      fail("cannot enforce an exact Spawnfile tools allowlist");
    }
    if (server.auth && (server.transport === "stdio" || server.auth.mode !== "bearer")) {
      fail("requires explicit bearer auth on a remote transport");
    }
    if (server.transport !== "stdio" && Object.keys(server.env ?? {}).length) {
      fail("cannot set a remote process environment");
    }
  }
}

function authoredServer(server: McpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return { type: "local", command: [server.command, ...server.args ?? []], environment: server.env };
  }
  return { type: "remote", url: server.url, oauth: false };
}

export function buildOpenCodeMcpConfig(node: ResolvedAgentNode): Record<string, Record<string, unknown>> {
  assertOpenCodeMcp(node);
  const memory = buildMnemeMemoryMcpServers(node);
  return {
    ...Object.fromEntries(node.mcpServers.map(server => [server.name, authoredServer(server)])),
    ...Object.fromEntries(Object.entries(memory).map(([name, server]) => [
      name, { type: "local", command: [server.command, ...(server.args as string[])] }
    ]))
  };
}

export function openCodeMcpCapabilities(node: ResolvedAgentNode): CapabilityReport[] {
  return node.mcpServers.map(server => ({
    key: `mcp.${server.name}`,
    ...(server.transport === "stdio"
      ? { outcome: "supported", message: "OpenCode connects the server through native stdio MCP" }
      : { outcome: "degraded", message: "OpenCode tries Streamable HTTP then SSE. The remote transport cannot be pinned" })
  }));
}

export function openCodeMcpEnvBindings(node: ResolvedAgentNode): RuntimeContainerConfigEnvBinding[] {
  return node.mcpServers.flatMap(server => server.auth?.mode === "bearer" ? [{
    envName: server.auth.secret,
    jsonPath: ["mcp", server.name, "headers", "Authorization"],
    transform: "bearer"
  }] : []);
}

export function openCodeMemoryCapability(node: ResolvedAgentNode) {
  if (hasUnsupportedMnemeMemoryAccess(node)) {
    return {
      memoryOutcome: "degraded",
      memoryMessage: "OpenCode connects file-backed Mneme banks with a runtime home"
    } as const;
  }
  if (node.memoryAccess?.some(({ bank }) => bank.consolidation.mode !== "disabled")) {
    return {
      memoryOutcome: "degraded",
      memoryMessage: "OpenCode connects Mneme in awake mode. Spawnfile consolidation is unavailable"
    } as const;
  }
  return {
    memoryOutcome: "supported",
    memoryMessage: "OpenCode connects file-backed Mneme banks through native stdio MCP"
  } as const;
}
