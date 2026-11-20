import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { McpServer } from "../../manifest/index.js";
import { SpawnfileError } from "../../shared/index.js";
import { NOOPOLIS_RUN_ID_ENV } from "../common.js";
import {
  buildMnemeMemoryMcpServers, hasUnsupportedMnemeMemoryAccess, isMnemeMemoryAccessSupported, mnemeMemoryServerName
} from "../mnemeMcp.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";

export function assertHermesMcp(node: ResolvedAgentNode): void {
  const normalize = (name: string) => name.replace(/[^A-Za-z0-9_]/gu, "_");
  const memoryPrefixes = (node.memoryAccess ?? []).filter(isMnemeMemoryAccessSupported)
    .map(access => `${normalize(mnemeMemoryServerName(node, access, "awake"))}__`);
  for (const server of node.mcpServers) {
    const fail = (reason: string): never => {
      throw new SpawnfileError("validation_error", `Hermes MCP server ${server.name} ${reason}`);
    };
    const prefix = `${normalize(server.name)}__`;
    if (memoryPrefixes.some(memory => memory.startsWith(prefix) || prefix.startsWith(memory))) {
      fail("has a native tool prefix that overlaps a generated Mneme server");
    }
    if (server.tools?.some(tool => /[*?\[]|\$\{/u.test(tool))) {
      fail("interprets wildcard and template syntax in tool names");
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
  const tools = server.tools ? { include: server.tools, resources: false, prompts: false } : undefined;
  if (server.transport === "stdio") {
    return { enabled: true, command: server.command, args: server.args, env: server.env,
      cwd: "<workspace-path>", tools };
  }
  return {
    enabled: true,
    url: server.url,
    transport: server.transport === "sse" ? "sse" : "streamable_http",
    ...(server.transport === "streamable_http" ? { strict_redirect_headers: true } : {}),
    tools
  };
}

export function buildHermesMcpConfig(node: ResolvedAgentNode): Record<string, Record<string, unknown>> {
  assertHermesMcp(node);
  const memory = buildMnemeMemoryMcpServers(node);
  return {
    ...Object.fromEntries(node.mcpServers.map(server => [server.name, authoredServer(server)])),
    ...Object.fromEntries(Object.entries(memory).map(([name, server]) => [
      name, { ...server, env: { [NOOPOLIS_RUN_ID_ENV]: "${" + NOOPOLIS_RUN_ID_ENV + "}" } }
    ]))
  };
}

export function hermesMcpEnvBindings(node: ResolvedAgentNode): RuntimeContainerConfigEnvBinding[] {
  return node.mcpServers.flatMap(server => server.auth?.mode === "bearer" ? [{
    envName: server.auth.secret,
    jsonPath: ["mcp_servers", server.name, "headers", "Authorization"],
    transform: "bearer"
  }] : []);
}

export function hermesMemoryCapability(node: ResolvedAgentNode) {
  if (hasUnsupportedMnemeMemoryAccess(node)) {
    return {
      memoryOutcome: "degraded",
      memoryMessage: "Hermes connects file-backed Mneme banks with a runtime home"
    } as const;
  }
  if (node.memoryAccess?.some(({ bank }) => bank.consolidation.mode !== "disabled")) {
    return {
      memoryOutcome: "degraded",
      memoryMessage: "Hermes connects Mneme in awake mode. Spawnfile consolidation is unavailable"
    } as const;
  }
  return {
    memoryOutcome: "supported",
    memoryMessage: "Hermes connects file-backed Mneme banks through native stdio MCP"
  } as const;
}
