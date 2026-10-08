import type { McpServer } from "../manifest/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { expandSourceWorkspacePathTemplate } from "./containerTargetResources.js";
import type { CompilePlanNode, ResolvedAgentNode } from "./types.js";

/**
 * Compiler-owned placeholders an MCP server may use in `command`, `args` and
 * `env` values. They are resolved per agent after the compile plan assigns
 * node ids, so one `shared.environment.mcp_servers` entry serves every member:
 *
 * - `${workspace}`  the agent's workspace path inside its runtime target
 *                   (the same path `./` workspace resource mounts link under)
 * - `${agent.id}`   the agent's compile-plan node id, e.g. `agent:writer`
 * - `${agent.name}` the agent manifest name
 *
 * `${workspace}` and anything under `${agent.` are reserved: an unknown name
 * fails the compile instead of reaching a runtime as a literal string. Other
 * `${...}` text is left untouched.
 */
const RESERVED_PLACEHOLDER = /\$\{(workspace|agent\.[^}]*)\}/gu;
const SUPPORTED = "${workspace}, ${agent.id}, ${agent.name}";

export interface McpPlaceholderContext {
  agentId: string;
  agentName: string;
  /** Lazy: only runtimes whose servers use `${workspace}` need a resolvable path. */
  workspace: () => string;
}

const fail = (context: McpPlaceholderContext, server: McpServer, detail: string): never => {
  throw new SpawnfileError(
    "validation_error",
    `Agent ${context.agentName} MCP server ${server.name}: ${detail}`
  );
};

const resolveValue = (
  value: string,
  server: McpServer,
  context: McpPlaceholderContext
): string =>
  value.replace(RESERVED_PLACEHOLDER, (match, name: string) => {
    if (name === "workspace") return context.workspace();
    if (name === "agent.id") return context.agentId;
    if (name === "agent.name") return context.agentName;
    return fail(context, server, `unknown placeholder ${match}; supported placeholders are ${SUPPORTED}`);
  });

const hasReservedPlaceholder = (value: string | undefined): boolean =>
  value !== undefined && new RegExp(RESERVED_PLACEHOLDER.source, "u").test(value);

export const resolveMcpServerPlaceholders = (
  servers: McpServer[],
  context: McpPlaceholderContext
): McpServer[] =>
  servers.map((server) => {
    if (hasReservedPlaceholder(server.url) || hasReservedPlaceholder(server.auth?.secret)) {
      fail(context, server, `placeholders (${SUPPORTED}) are only supported in command, args and env values`);
    }
    return {
      ...server,
      ...(server.command === undefined ? {} : { command: resolveValue(server.command, server, context) }),
      ...(server.args === undefined ? {} : { args: server.args.map((arg) => resolveValue(arg, server, context)) }),
      ...(server.env === undefined ? {} : {
        env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, resolveValue(value, server, context)]))
      })
    };
  });

/** Resolves every agent node's MCP placeholders in place, once node ids and slugs exist. */
export const resolvePlanMcpPlaceholders = (nodes: CompilePlanNode[]): void => {
  for (const node of nodes) {
    if (node.value.kind !== "agent" || node.value.mcpServers.length === 0) continue;
    const agent: ResolvedAgentNode = node.value;
    agent.mcpServers = resolveMcpServerPlaceholders(agent.mcpServers, {
      agentId: node.id,
      agentName: agent.name,
      workspace: () => expandSourceWorkspacePathTemplate(
        getRuntimeAdapter(node.runtimeName ?? agent.runtime.name).container,
        { agentName: agent.name, slug: node.slug }
      )
    });
  }
};
