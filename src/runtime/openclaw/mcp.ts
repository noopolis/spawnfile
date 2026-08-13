import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { McpServer } from "../../manifest/index.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";
import {
  buildMnemeMemoryMcpServers,
  hasScheduledMemoryConsolidation,
  hasUnsupportedMnemeMemoryAccess
} from "../mnemeMcp.js";

const buildOpenClawAuthHeaders = (
  server: McpServer
): Record<string, string> | undefined =>
  server.auth
    ? { [server.auth.mode === "bearer" ? "Authorization" : server.auth.secret]: "" }
    : undefined;

export const buildOpenClawAuthoredMcpServers = (
  servers: McpServer[]
): Record<string, Record<string, unknown>> => {
  const result: Record<string, Record<string, unknown>> = Object.create(null);

  for (const server of servers) {
    if (server.transport === "stdio" && server.auth?.mode === "bearer") {
      throw new Error("OpenClaw stdio MCP servers do not support bearer auth");
    }
    const entry: Record<string, unknown> = { enabled: true };

    if (server.transport === "stdio") {
      entry.transport = "stdio";
      entry.command = server.command;
      if (server.args) entry.args = server.args;
      if (server.env) entry.env = server.env;
    } else {
      entry.transport = server.transport === "streamable_http" ? "streamable-http" : "sse";
      entry.url = server.url;
      const headers = buildOpenClawAuthHeaders(server);
      if (headers) entry.headers = headers;
    }

    result[server.name] = entry;
  }

  return result;
};

export const buildOpenClawMcpConfig = (
  node: ResolvedAgentNode
): Record<string, unknown> | undefined => {
  const servers = {
    ...buildOpenClawAuthoredMcpServers(node.mcpServers),
    ...buildMnemeMemoryMcpServers(node, {
      modes: hasScheduledMemoryConsolidation(node) ? ["awake", "dream"] : ["awake"]
    })
  };

  if (Object.keys(servers).length === 0) {
    return undefined;
  }

  return { servers };
};

export const buildOpenClawMcpEnvBindings = (
  servers: McpServer[]
): RuntimeContainerConfigEnvBinding[] =>
  servers.flatMap((server) =>
    server.auth
      ? [
          {
            envName: server.auth.secret,
            jsonPath: [
              "mcp",
              "servers",
              server.name,
              "headers",
              server.auth.mode === "bearer" ? "Authorization" : server.auth.secret
            ],
            ...(server.auth.mode === "bearer" ? { transform: "bearer" as const } : {})
          }
        ]
      : []
  );

export const openClawMemoryCapabilityFor = (
  node: ResolvedAgentNode
): {
  message: string;
  outcome: "degraded" | "supported";
} => {
  if (hasUnsupportedMnemeMemoryAccess(node)) {
    return {
      message: "OpenClaw lowers file-backed Mneme memory through generated MCP servers; non-file stores are not lowered",
      outcome: "degraded"
    };
  }

  return {
    message: "OpenClaw accesses Mneme memory through generated MCP servers",
    outcome: "supported"
  };
};
