import { McpServer } from "../manifest/index.js";

/**
 * Generate the team-mcp.js script content.
 * This is a self-contained Node.js script that implements an MCP server over stdio
 * with one tool: team_message.
 *
 * The script reads SPAWNFILE_ROUTER_URL and SPAWNFILE_AGENT_NAME from env.
 * When team_message is called, it POSTs to the router to deliver the message.
 */
export const generateTeamMcpScript = (): string => {
  return `"use strict";

const TOOL_DEFINITION = {
  name: "team_message",
  description: "Send a message to a teammate and wait for their response. Check your team roster to see who your teammates are.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Teammate name from your roster" },
      message: { type: "string", description: "The message to send" }
    },
    required: ["to", "message"]
  }
};

const SERVER_INFO = {
  name: "spawnfile_team",
  version: "0.1.0"
};

const handleInitialize = (id) => ({
  jsonrpc: "2.0",
  id,
  result: {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO
  }
});

const handleToolsList = (id) => ({
  jsonrpc: "2.0",
  id,
  result: { tools: [TOOL_DEFINITION] }
});

const handleToolsCall = async (id, params) => {
  const toolName = params.name;
  if (toolName !== "team_message") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Unknown tool: " + toolName }
    };
  }

  const args = params.arguments || {};
  const routerUrl = process.env.SPAWNFILE_ROUTER_URL;
  const agentName = process.env.SPAWNFILE_AGENT_NAME;
  const teamSecret = process.env.SPAWNFILE_TEAM_SECRET;

  if (!routerUrl) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "Error: SPAWNFILE_ROUTER_URL is not set" }],
        isError: true
      }
    };
  }

  if (!agentName) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "Error: SPAWNFILE_AGENT_NAME is not set" }],
        isError: true
      }
    };
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (teamSecret) {
      headers["Authorization"] = "Bearer " + teamSecret;
    }

    const response = await fetch(routerUrl + "/team/message", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: agentName,
        to: args.to,
        message: args.message,
        context_id: "team:" + agentName + "->" + args.to
      })
    });

    const result = await response.json();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }]
      }
    };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "Error: " + (err.message || String(err)) }],
        isError: true
      }
    };
  }
};

const processMessage = async (message) => {
  const { method, id, params } = message;

  if (method === "initialize") {
    return handleInitialize(id);
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return handleToolsList(id);
  }

  if (method === "tools/call") {
    return handleToolsCall(id, params);
  }

  if (id !== undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found: " + method }
    };
  }

  return null;
};

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const message = JSON.parse(trimmed);
      const response = await processMessage(message);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + "\\n");
      }
    } catch (err) {
      // Skip malformed input
    }
  }
});
`;
};

/**
 * Generate the MCP server config entry for the team communication tool.
 * This gets injected into each team member's mcp_servers list.
 */
export const createTeamMcpServerEntry = (instanceRoot: string): McpServer => ({
  name: "spawnfile_team",
  transport: "stdio" as const,
  command: "node",
  args: [`${instanceRoot}/.spawnfile/team-mcp.js`]
});
