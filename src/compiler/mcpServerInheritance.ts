import {
  isMcpServerDeclaration,
  type McpServer,
  type McpServerEntry,
  type SharedMcpServer
} from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

/**
 * Resolves an agent's effective MCP servers from its team's
 * `shared.environment.mcp_servers` and its own entries.
 *
 * - A local entry that declares `transport` is a complete server and replaces
 *   any inherited server of the same name (SPEC §4.4: member-local wins).
 * - A local entry without `transport` narrows the inherited server of the same
 *   name: `tools` replaces the inherited allowlist, `env` merges key by key
 *   with local keys winning. Every other field stays inherited.
 * - A bare `{ name }` takes the inherited server unchanged.
 * - A shared server marked `opt_in: true` is inherited only by members that
 *   list its name (bare or narrowing). Members never remove an inherited
 *   server (SPEC §4.4); an opt-in server is simply not offered by default.
 * - An override with no shared server to narrow is a compile error naming
 *   the agent, because there is nothing to complete it from.
 */
export const resolveInheritedMcpServers = (
  agentName: string,
  sharedServers: SharedMcpServer[] = [],
  localEntries: McpServerEntry[] = []
): McpServer[] => {
  const inherited = new Map<string, McpServer>();
  const resolved = new Map<string, McpServer>();
  for (const { opt_in: optIn, ...server } of sharedServers) {
    inherited.set(server.name, server);
    if (optIn !== true) resolved.set(server.name, server);
  }

  for (const entry of localEntries) {
    if (isMcpServerDeclaration(entry)) {
      resolved.set(entry.name, entry);
      continue;
    }

    const base = inherited.get(entry.name);
    if (!base) {
      throw new SpawnfileError(
        "validation_error",
        `Agent ${agentName} overrides MCP server ${entry.name}, but its team declares no shared.environment.mcp_servers entry named ${entry.name}; declare transport to define the server locally`
      );
    }

    resolved.set(entry.name, {
      ...base,
      ...(entry.tools === undefined ? {} : { tools: entry.tools }),
      ...(entry.env === undefined ? {} : { env: { ...base.env, ...entry.env } })
    });
  }

  return [...resolved.values()];
};
