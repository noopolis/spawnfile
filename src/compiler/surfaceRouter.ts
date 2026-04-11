import {
  CompilePlan,
  ResolvedAgentNode,
  ResolvedTeamNode
} from "./types.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import {
  PICOCLAW_GATEWAY_BASE_PORT,
  PICOCLAW_INTERNAL_PICO_TOKEN
} from "../runtime/picoclaw/pico.js";

export interface RouterRoute {
  agentId: string;
  runtimeToken?: string;
  runtimeConfigPath?: string;
  runtimeHomePath?: string;
  runtime: string;
  runtimeUrl: string;
}

export interface RouterConfig {
  defaultAgent: string | null;
  port: number;
  routes: RouterRoute[];
  teamAuthSecret?: string;
}

const resolveSequentialRuntimePort = (
  plan: CompilePlan,
  runtimeName: string,
  slug: string,
  fallbackPort?: number
): number | undefined => {
  let adapterPort: number | undefined;
  let adapterPortStride = 1;
  try {
    const container = getRuntimeAdapter(runtimeName).container;
    adapterPort = container.port;
    adapterPortStride = container.portStride ?? 1;
  } catch (_err) {
    adapterPort = undefined;
    adapterPortStride = 1;
  }

  const basePort = adapterPort ?? fallbackPort;
  if (basePort === undefined) {
    return undefined;
  }

  const runtimeAgents = plan.nodes.filter(
    (node) => node.kind === "agent" && node.runtimeName === runtimeName
  );
  const index = runtimeAgents.findIndex((node) => node.slug === slug);
  return index >= 0 ? basePort + (index * adapterPortStride) : basePort;
};

/**
 * Generate the surface-router.js script content.
 * Self-contained Node.js HTTP server, no dependencies.
 */
export const generateSurfaceRouterScript = (): string => {
  return `"use strict";
const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { WebSocket } = globalThis;

if (typeof fetch !== "function") {
  throw new Error("[surface-router] global fetch is unavailable");
}

if (typeof WebSocket !== "function") {
  throw new Error("[surface-router] global WebSocket is unavailable");
}

const configPath = process.argv[2];
if (!configPath) {
  console.error("[surface-router] usage: node surface-router.js <config.json>");
  process.exit(1);
}

const config = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
const routes = new Map(config.routes.map(r => [r.agentId, r]));

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
const stripAnsi = (value) => value.replace(/\\u001b\\[[0-9;]*m/g, "").replace(/\\r/g, "");
const sanitizeRouteSessionId = (value) => value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "default";
const sanitizePicoSessionId = (value) => value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "default";
const buildSessionId = (body, targetAgentId, sender) => sanitizeRouteSessionId(body.sessionKey || body.context_id || ("route-" + sender + "-to-" + targetAgentId));
const parseMoltnetContextId = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("moltnet:")) return null;
  const chatId = trimmed.slice("moltnet:".length);
  if (!chatId) return null;
  return { chatId, contextId: trimmed };
};
const buildPicoClawMessage = (body, sender, message) => {
  const moltnetContext = parseMoltnetContextId(body.context_id);
  if (!moltnetContext) {
    return message;
  }

  return [
    "[Moltnet context]",
    "conversation: " + moltnetContext.contextId,
    "channel: moltnet",
    "chat_id: " + moltnetContext.chatId,
    "sender: " + sender,
    "[/Moltnet context]",
    "",
    message
  ].join("\\n");
};
const buildPicoClawDispatch = (body, targetAgentId, sender) => {
  const moltnetContext = parseMoltnetContextId(body.context_id);
  if (moltnetContext) {
    const explicitSessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
    const sessionId = explicitSessionKey.startsWith("agent:")
      ? explicitSessionKey
      : "agent:" + targetAgentId + ":" + moltnetContext.contextId;
    return {
      discardDirectReply: true,
      message: buildPicoClawMessage(body, sender, body.message),
      sessionId: sanitizePicoSessionId(sessionId)
    };
  }

  return {
    discardDirectReply: false,
    message: body.message,
    sessionId: buildSessionId(body, targetAgentId, sender)
  };
};
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const readAgentId = (body) => {
  if (typeof body.to === "string" && body.to.trim()) return body.to.trim();
  if (typeof body.agentId === "string" && body.agentId.trim()) return body.agentId.trim();
  return "";
};
const readSender = (body) => {
  if (typeof body.from === "string" && body.from.trim()) return body.from.trim();
  if (isRecord(body.from)) {
    if (typeof body.from.name === "string" && body.from.name.trim()) return body.from.name.trim();
    if (typeof body.from.id === "string" && body.from.id.trim()) return body.from.id.trim();
  }
  if (typeof body.name === "string" && body.name.trim()) return body.name.trim();
  return "api";
};
const isHookDispatch = (body) =>
  typeof body.agentId === "string" &&
  body.agentId.trim().length > 0 &&
  typeof body.message === "string";

const runCommand = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error(command + " timeout"));
  }, 120000);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });

  child.once("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      reject(new Error(command + " exited with code " + code + ": " + stripAnsi(stderr || stdout).trim()));
      return;
    }
    resolve({ stdout, stderr });
  });
});

const parseOpenClawOutput = (stdout) => {
  const trimmed = stdout.trim();
  const payload = JSON.parse(trimmed);
  const texts = (((payload || {}).result || {}).payloads || [])
    .map((entry) => entry && typeof entry.text === "string" ? entry.text : "")
    .filter(Boolean);
  if (texts.length > 0) {
    return texts.join("\\n").trim();
  }
  return (((payload || {}).result || {}).summary || payload.summary || "").toString().trim();
};

const parsePicoClawOutput = (stdout, stderr) => {
  const cleanedLines = stripAnsi((stdout || "") + "\\n" + (stderr || ""))
    .split("\\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = cleanedLines.length - 1; index >= 0; index -= 1) {
    const line = cleanedLines[index];
    if (line.startsWith("🦞")) {
      return line.replace(/^🦞\\s*/u, "").trim();
    }
    const responseMatch = line.match(/Response:\\s*(.+)$/);
    if (responseMatch) {
      return responseMatch[1].trim();
    }
  }

  return cleanedLines[cleanedLines.length - 1] || "";
};

const sendPicoClawViaPico = async (route, dispatch) => {
  let pidToken = "";
  if (route.runtimeHomePath) {
    try {
      const pidState = JSON.parse(fs.readFileSync(route.runtimeHomePath + "/.picoclaw.pid", "utf-8"));
      if (pidState && typeof pidState.token === "string" && pidState.token.trim()) {
        pidToken = pidState.token.trim();
      }
    } catch (_err) {
      pidToken = "";
    }
  }
  let runtimeToken = route.runtimeToken || "";
  if (pidToken && runtimeToken && !runtimeToken.startsWith("pico-")) {
    runtimeToken = "pico-" + pidToken + runtimeToken;
  }
  if (!runtimeToken) {
    throw new Error("PicoClaw route is missing pico token");
  }

  const socketUrl = new URL(route.runtimeUrl);
  socketUrl.searchParams.set("session_id", dispatch.sessionId);
  socketUrl.searchParams.set("token", runtimeToken);

  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl.toString());
    const timer = setTimeout(() => {
      try { socket.close(); } catch (_err) {}
      reject(new Error("PicoClaw pico websocket timeout"));
    }, 10000);

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      const message = event && event.error && event.error.message
        ? event.error.message
        : "PicoClaw pico websocket error";
      reject(new Error(message));
    });
  });

  ws.send(JSON.stringify({
    type: "message.send",
    session_id: dispatch.sessionId,
    payload: {
      content: dispatch.message
    }
  }));

  // PicoClaw needs a short grace window after message.send so the gateway can
  // hand the inbound event to the agent loop before the client disconnects.
  await sleep(1000);
  ws.close();
};

const resolveOpenClawHookUrl = (route) => {
  const runtimeUrl = route.runtimeUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const url = new URL(runtimeUrl);
  url.pathname = "/hooks/agent";
  url.search = "";
  url.hash = "";
  return url.toString();
};

const sendOpenClawHook = async (route, body) => {
  const hookUrl = resolveOpenClawHookUrl(route);
  const token = (
    process.env.OPENCLAW_HOOKS_TOKEN ||
    (process.env.OPENCLAW_GATEWAY_TOKEN ? "hooks-" + process.env.OPENCLAW_GATEWAY_TOKEN : "") ||
    ""
  ).trim();
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = "Bearer " + token;
  }

  const hookBody = {
    message: body.message,
    ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}),
    ...(typeof body.sessionKey === "string" && body.sessionKey.trim()
      ? { sessionKey: body.sessionKey.trim() }
      : {}),
    ...(typeof body.wakeMode === "string" && body.wakeMode.trim()
      ? { wakeMode: body.wakeMode.trim() }
      : { wakeMode: "now" }),
    ...(typeof body.disableMessageTool === "boolean"
      ? { disableMessageTool: body.disableMessageTool }
      : {}),
    ...(typeof body.deliver === "boolean" ? { deliver: body.deliver } : { deliver: false })
  };

  const response = await fetch(hookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(hookBody),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error("OpenClaw hook failed (" + response.status + "): " + errBody);
  }

  const result = await response.json().catch(() => ({}));
  return typeof result.runId === "string" ? result.runId : "";
};

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
  const cooldown = 15000;
  const deadline = Date.now() + maxWait;

  // TinyClaw team delegation produces multiple responses:
  // 1. Delegation acknowledgment from the lead
  // 2. Internal routing messages
  // 3. Final synthesized answer from the lead
  // We consume all responses, keeping the last one from the target agent.
  let lastMessage = null;
  let lastResponseTime = 0;

  while (Date.now() < deadline) {
    await sleep(pollInterval);
    const pollRes = await fetch(pollUrl);
    if (!pollRes.ok) continue;
    const pending = await pollRes.json();
    if (!Array.isArray(pending) || pending.length === 0) {
      // No new responses — if we have one and cooldown passed, return it
      if (lastMessage !== null && (Date.now() - lastResponseTime) > cooldown) {
        return lastMessage;
      }
      continue;
    }

    // ACK and consume all pending responses, keeping the last one from the target agent
    for (const entry of pending) {
      const ackUrl = origin + "/api/responses/" + entry.id + "/ack";
      await fetch(ackUrl, { method: "POST" }).catch(() => {});
      if (!entry.agent || entry.agent === targetAgentId) {
        lastMessage = entry.message || "";
        lastResponseTime = Date.now();
      }
    }
  }

  if (lastMessage !== null) return lastMessage;
  throw new Error("TinyClaw response timeout after " + maxWait + "ms");
};

const sendTinyClawNoWait = async (baseUrl, targetAgentId, fromAgent, message) => {
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
};

const sendOpenClaw = async (route, targetAgentId, body, sender, message) => {
  if (!route.runtimeConfigPath || !route.runtimeHomePath) {
    throw new Error("OpenClaw route is missing runtime paths");
  }

  const sessionId = buildSessionId(body, targetAgentId, sender);
  const result = await runCommand(
    "openclaw",
    ["agent", "--session-id", sessionId, "--message", message, "--json"],
    {
      HOME: route.runtimeHomePath,
      OPENCLAW_CONFIG_PATH: route.runtimeConfigPath,
      OPENCLAW_HOME: route.runtimeHomePath
    }
  );
  return parseOpenClawOutput(result.stdout);
};

const sendOpenClawNoWait = async (route, targetAgentId, body, sender) => {
  return sendOpenClawHook(route, {
    agentId: targetAgentId,
    deliver: false,
    from: body.from,
    message: body.message,
    name: sender,
    sessionKey: buildSessionId(body, targetAgentId, sender),
    wakeMode: "now"
  });
};

const sendPicoClaw = async (route, targetAgentId, body, sender, message) => {
  if (!route.runtimeConfigPath || !route.runtimeHomePath) {
    throw new Error("PicoClaw route is missing runtime paths");
  }

  const dispatch = buildPicoClawDispatch(body, targetAgentId, sender);
  const result = await runCommand(
    "picoclaw",
    [
      "agent",
      "--session", dispatch.sessionId,
      "--message", dispatch.message
    ],
    {
      HOME: route.runtimeHomePath,
      PICOCLAW_CONFIG: route.runtimeConfigPath,
      PICOCLAW_HOME: route.runtimeHomePath
    }
  );
  if (dispatch.discardDirectReply) {
    return "";
  }
  return parsePicoClawOutput(result.stdout, result.stderr);
};

const sendPicoClawNoWait = async (route, targetAgentId, body, sender) => {
  const dispatch = buildPicoClawDispatch(body, targetAgentId, sender);
  await sendPicoClawViaPico(route, dispatch);
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

const sendToRouteNoWait = async (route, body, targetAgentId, sender, authHeaders) => {
  if (route.runtime === "tinyclaw") {
    await sendTinyClawNoWait(route.runtimeUrl, targetAgentId, sender, body.message);
    return "";
  }
  if (route.runtime === "openclaw") {
    await sendOpenClawNoWait(route, targetAgentId, body, sender);
    return "";
  }
  if (route.runtime === "picoclaw") {
    await sendPicoClawNoWait(route, targetAgentId, body, sender);
    return "";
  }
  await sendDefault(route.runtimeUrl, body, authHeaders);
  return "";
};

const sendToRoute = async (route, body, targetAgentId, sender, authHeaders) => {
  if (route.runtime === "tinyclaw") {
    return sendTinyClaw(route.runtimeUrl, targetAgentId, sender, body.message);
  }
  if (route.runtime === "openclaw") {
    if (isHookDispatch(body)) {
      return sendOpenClawHook(route, body);
    }
    return sendOpenClaw(route, targetAgentId, body, sender, body.message);
  }
  if (route.runtime === "picoclaw") {
    return sendPicoClaw(route, targetAgentId, body, sender, body.message);
  }
  return sendDefault(route.runtimeUrl, body, authHeaders);
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

    const targetAgentId = readAgentId(body);
    if (!targetAgentId) {
      json(res, 400, { error: "target agent required" });
      return;
    }

    const route = routes.get(targetAgentId);
    if (!route) {
      json(res, 404, { error: "unknown agent: " + targetAgentId });
      return;
    }

    try {
      const authHeaders = {};
      if (config.teamAuthSecret && process.env[config.teamAuthSecret]) {
        authHeaders["Authorization"] = "Bearer " + process.env[config.teamAuthSecret];
      }

      const sender = readSender(body);
      const shouldAwaitResponse = body.await_response !== false;
      const responseMessage = shouldAwaitResponse
        ? await sendToRoute(route, body, targetAgentId, sender, authHeaders)
        : await sendToRouteNoWait(route, body, targetAgentId, sender, authHeaders);

      if (isHookDispatch(body)) {
        json(res, 200, {
          ok: true,
          agentId: targetAgentId,
          delivered: false,
          sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : null,
          summary: responseMessage || null
        });
        return;
      }

      if (!shouldAwaitResponse) {
        json(res, 200, { ok: true, from: targetAgentId, delivered: false });
        return;
      }

      json(res, 200, { from: targetAgentId, message: responseMessage });
    } catch (err) {
      json(res, 502, { error: "failed to reach " + targetAgentId + ": " + err.message });
    }
    return;
  }

  // Portable HTTP contract: POST /v1/messages
  // Routes to the team's default (external-facing) agent
  if (req.method === "POST" && req.url === "/v1/messages") {
    const defaultAgentId = config.defaultAgent;
    if (!defaultAgentId) {
      json(res, 503, { error: "no default agent configured" });
      return;
    }
    const route = routes.get(defaultAgentId);
    if (!route) {
      json(res, 503, { error: "default agent not found in routes: " + defaultAgentId });
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (_err) {
      json(res, 400, { error: "invalid request body" });
      return;
    }

    try {
      let parsed;
      try { parsed = JSON.parse(body); } catch (_e) { parsed = { message: body }; }
      const message = parsed.message || parsed.body || body;
      const from = parsed.from || { type: "human", id: "api" };

      const sender = typeof from === "string" ? from : (from.name || from.id || "api");
      const responseMessage = await sendToRoute(
        route,
        { context_id: parsed.context_id, from, message, to: defaultAgentId },
        defaultAgentId,
        sender,
        {}
      );

      json(res, 200, {
        message_id: "msg_" + Date.now(),
        from: { type: "agent", id: defaultAgentId },
        message: responseMessage
      });
    } catch (err) {
      json(res, 502, { error: "agent error: " + err.message });
    }
    return;
  }

  // Internal routing: POST /route/:agentId/v1/messages
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
      const parsed = JSON.parse(body);
      const sender = typeof parsed.from === "string"
        ? parsed.from
        : (parsed.from && (parsed.from.name || parsed.from.id)) || "api";
      const result = await sendToRoute(route, parsed, agentId, sender, {});
      json(res, 200, { from: agentId, message: result });
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
    const runtimePort =
      runtimeName === "openclaw"
        ? resolveSequentialRuntimePort(plan, runtimeName, memberNode.slug, 18789)
        : runtimeName === "picoclaw"
          ? resolveSequentialRuntimePort(plan, runtimeName, memberNode.slug, PICOCLAW_GATEWAY_BASE_PORT)
          : undefined;

    let runtimeUrl: string;
    let runtimeHomePath: string | undefined;
    let runtimeConfigPath: string | undefined;

    if (runtimeName === "tinyclaw") {
      runtimeUrl = `http://localhost:${httpPort ?? 3777}/api/message`;
      runtimeHomePath = "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi";
      runtimeConfigPath = "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi/settings.json";
    } else if (runtimeName === "openclaw") {
      runtimeUrl = `ws://localhost:${httpPort ?? runtimePort ?? 18789}`;
      runtimeHomePath = `/var/lib/spawnfile/instances/openclaw/agent-${memberNode.slug}/home`;
      runtimeConfigPath = `${runtimeHomePath}/.openclaw/openclaw.json`;
    } else if (runtimeName === "picoclaw") {
      runtimeUrl = `ws://localhost:${httpPort ?? runtimePort ?? PICOCLAW_GATEWAY_BASE_PORT}/pico/ws`;
      runtimeHomePath = `/var/lib/spawnfile/instances/picoclaw/agent-${memberNode.slug}/picoclaw`;
      runtimeConfigPath = `${runtimeHomePath}/config.json`;
    } else {
      runtimeUrl = `http://localhost:${httpPort ?? 8080}${pathPrefix}/messages`;
    }

    routes.push({
      agentId: member.id,
      ...(runtimeName === "picoclaw" && agentNode.surfaces?.moltnet
        ? { runtimeToken: PICOCLAW_INTERNAL_PICO_TOKEN }
        : {}),
      ...(runtimeConfigPath ? { runtimeConfigPath } : {}),
      ...(runtimeHomePath ? { runtimeHomePath } : {}),
      runtime: runtimeName,
      runtimeUrl
    });
  }

  // The default agent is the first external-facing member (the lead in hierarchical mode)
  const defaultAgent = teamNode.external.length > 0
    ? teamNode.external[0]
    : (teamNode.lead ?? (teamNode.members[0]?.id ?? null));

  return {
    defaultAgent: defaultAgent ?? null,
    port: routerPort,
    routes,
    ...(teamNode.auth ? { teamAuthSecret: teamNode.auth.secret } : {})
  };
};
