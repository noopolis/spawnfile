import type { McpServer } from "../../manifest/index.js";
import type { RuntimeContainerConfigEnvBinding } from "../types.js";

export const buildPicoClawAuthoredMcpServers = (
  servers: McpServer[]
): Record<string, Record<string, unknown>> => {
  const result: Record<string, Record<string, unknown>> = Object.create(null);

  for (const server of servers) {
    if (server.transport === "stdio" && server.auth?.mode === "bearer") {
      throw new Error("PicoClaw stdio MCP servers do not support bearer auth");
    }
    const entry: Record<string, unknown> = { enabled: true };

    if (server.transport === "stdio") {
      entry.command = server.command;
      if (server.args) entry.args = server.args;
      if (server.env) entry.env = server.env;
    } else {
      entry.type = server.transport === "streamable_http" ? "http" : server.transport;
      entry.url = server.url;
    }

    if (server.auth) {
      entry.headers = {
        [server.auth.mode === "bearer" ? "Authorization" : server.auth.secret]: ""
      };
    }

    result[server.name] = entry;
  }

  return result;
};

export const buildPicoClawMcpEnvBindings = (
  servers: McpServer[]
): RuntimeContainerConfigEnvBinding[] =>
  servers.flatMap((server) =>
    server.auth
      ? [
          {
            envName: server.auth.secret,
            jsonPath: [
              "tools",
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
