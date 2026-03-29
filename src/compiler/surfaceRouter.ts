import {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "./types.js";

export interface RouterRoute {
  agentId: string;
  runtime: string;
  runtimeUrl: string;
}

export interface RouterConfig {
  port: number;
  routes: RouterRoute[];
  teamAuthSecret?: string;
}

/**
 * Generate the surface-router.js script content.
 * Self-contained Node.js HTTP server, no dependencies.
 */
export const generateSurfaceRouterScript = (): string => {
  return `"use strict";
const http = require("node:http");

const configPath = process.argv[2];
if (!configPath) {
  console.error("[surface-router] usage: node surface-router.js <config.json>");
  process.exit(1);
}

const config = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
const routes = new Map(config.routes.map(r => [r.agentId, { url: r.runtimeUrl, runtime: r.runtime }]));

const readBody = async (req) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
};

const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendTinyClaw = async (baseUrl, targetAgentId, fromAgent, message) => {
  const channel = "team:" + fromAgent;
  const postRes = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: message,
      agent: targetAgentId,
      sender: fromAgent,
      channel: channel
    })
  });

  if (!postRes.ok) {
    const errBody = await postRes.text();
    throw new Error("TinyClaw POST failed (" + postRes.status + "): " + errBody);
  }

  const origin = new URL(baseUrl).origin;
  const pollUrl = origin + "/api/responses/pending?channel=" + encodeURIComponent(channel);
  const maxWait = 120000;
  const pollInterval = 1000;
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    await sleep(pollInterval);
    const pollRes = await fetch(pollUrl);
    if (!pollRes.ok) continue;
    const pending = await pollRes.json();
    if (!Array.isArray(pending) || pending.length === 0) continue;

    const entry = pending[0];
    const ackUrl = origin + "/api/responses/" + entry.id + "/ack";
    await fetch(ackUrl, { method: "POST" }).catch(() => {});
    return entry.message || "";
  }

  throw new Error("TinyClaw response timeout after " + maxWait + "ms");
};

const sendDefault = async (targetUrl, body, authHeaders) => {
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      message: body.message,
      from: body.from,
      context_id: body.context_id || ("team:" + body.from + "->" + body.to)
    }),
    signal: AbortSignal.timeout(120000)
  });
  const result = await response.json();
  return result.message || result.response || JSON.stringify(result);
};

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { status: "ok", agents: config.routes.map(r => r.agentId) });
    return;
  }

  if (req.method === "POST" && req.url === "/team/message") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (_err) {
      json(res, 400, { error: "invalid json" });
      return;
    }

    if (config.teamAuthSecret) {
      const expectedToken = process.env[config.teamAuthSecret];
      const authHeader = req.headers["authorization"];
      if (expectedToken && authHeader !== "Bearer " + expectedToken) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
    }

    const route = routes.get(body.to);
    if (!route) {
      json(res, 404, { error: "unknown agent: " + body.to });
      return;
    }

    try {
      const authHeaders = {};
      if (config.teamAuthSecret && process.env[config.teamAuthSecret]) {
        authHeaders["Authorization"] = "Bearer " + process.env[config.teamAuthSecret];
      }

      let responseMessage;
      if (route.runtime === "tinyclaw") {
        responseMessage = await sendTinyClaw(route.url, body.to, body.from, body.message);
      } else {
        responseMessage = await sendDefault(route.url, body, authHeaders);
      }

      json(res, 200, { from: body.to, message: responseMessage });
    } catch (err) {
      json(res, 502, { error: "failed to reach " + body.to + ": " + err.message });
    }
    return;
  }

  const routeMatch = req.url && req.url.match(/^\\/route\\/([^/]+)\\/v1\\/messages$/);
  if (req.method === "POST" && routeMatch) {
    const agentId = routeMatch[1];
    const route = routes.get(agentId);
    if (!route) {
      json(res, 404, { error: "unknown agent: " + agentId });
      return;
    }

    const body = await readBody(req);

    try {
      const response = await fetch(route.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        signal: AbortSignal.timeout(120000)
      });
      const result = await response.text();
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(result);
    } catch (err) {
      json(res, 502, { error: "failed to reach " + agentId + ": " + err.message });
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(config.port, () => {
  console.log("[surface-router] listening on port " + config.port);
  console.log("[surface-router] routes: " + [...routes.keys()].join(", "));
});
`;
};

/**
 * Generate the router config JSON for a team.
 */
export const generateRouterConfig = (
  teamNode: ResolvedTeamNode,
  plan: CompilePlan,
  routerPort: number
): RouterConfig => {
  const routes: RouterRoute[] = [];

  for (const member of teamNode.members) {
    const memberNode = plan.nodes.find((n) => n.value.source === member.nodeSource);
    if (!memberNode || memberNode.kind !== "agent") continue;

    const agentNode = memberNode.value as ResolvedAgentNode;
    const httpPort = agentNode.surfaces?.http?.port;
    const pathPrefix = agentNode.surfaces?.http?.pathPrefix ?? "/v1";
    const runtimeName = agentNode.runtime.name;

    let runtimeUrl: string;
    if (runtimeName === "tinyclaw") {
      runtimeUrl = `http://localhost:${httpPort ?? 3777}/api/message`;
    } else {
      runtimeUrl = `http://localhost:${httpPort ?? 8080}${pathPrefix}/messages`;
    }

    routes.push({ agentId: member.id, runtime: runtimeName, runtimeUrl });
  }

  return {
    port: routerPort,
    routes,
    ...(teamNode.auth ? { teamAuthSecret: teamNode.auth.secret } : {})
  };
};
