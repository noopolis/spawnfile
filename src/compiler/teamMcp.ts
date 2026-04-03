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
  description: "Send a private routed message to a teammate through Spawnfile team routing. Use this tool, not the generic message tool, for teammate coordination.",
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

export const generateTeamMessageCliScript = (): string => {
  return `#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let to = "";
let message = "";

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--to") {
    to = args[index + 1] || "";
    index += 1;
    continue;
  }
  if (arg === "--message") {
    message = args[index + 1] || "";
    index += 1;
    continue;
  }
}

const fail = (text) => {
  console.error(text);
  process.exit(1);
};

if (!to.trim()) fail("--to is required");
if (!message.trim()) fail("--message is required");

const resolveConfigPath = () => {
  const explicit = process.env.SPAWNFILE_TEAM_CONFIG;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, ".spawnfile", "team.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  fail("could not locate .spawnfile/team.json from " + process.cwd());
};

const configPath = resolveConfigPath();
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const routerUrl = typeof config.router_url === "string" ? config.router_url : "";
const agentName = typeof config.agent_name === "string" ? config.agent_name : "";
const teamSecretEnv = typeof config.team_secret_env === "string" ? config.team_secret_env : "";
const teamSecret = teamSecretEnv ? (process.env[teamSecretEnv] || "") : "";

if (!routerUrl) fail("router_url is not set in " + configPath);
if (!agentName) fail("agent_name is not set in " + configPath);

const headers = { "Content-Type": "application/json" };
if (teamSecret) {
  headers.Authorization = "Bearer " + teamSecret;
}

const main = async () => {
  const response = await fetch(routerUrl + "/team/message", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: agentName,
      to,
      message,
      context_id: "team:" + agentName + "->" + to
    })
  });

  const text = await response.text();
  if (!response.ok) {
    fail(text || ("team message failed with status " + response.status));
  }

  process.stdout.write(text);
};

main().catch((error) => fail(error && error.message ? error.message : String(error)));
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
