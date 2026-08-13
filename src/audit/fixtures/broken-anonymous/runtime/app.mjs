const rebuildAgentKeys = (agents) => {
  const keys = new Map();
  for (const agent of agents) {
    const candidates = [
      agent.config.id,
      agent.config.name,
      agent.config.slug,
      typeof agent.config.id === "string" && agent.config.id.startsWith("agent:")
        ? agent.config.id.slice("agent:".length)
        : ""
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) {
        keys.set(candidate, agent);
      }
    }
  }
  return keys;
};

const formatControlEventId = (payload, fallbackPrefix) => {
  if (typeof payload.event_id === "string" && payload.event_id.length > 0) {
    return payload.event_id;
  }
  if (typeof payload.context_id === "string" && payload.context_id.length > 0) {
    return payload.context_id + ":" + Date.now();
  }
  return fallbackPrefix + Date.now();
};

// B62 Option B (two wake endpoints split by authenticating authority):
// POST /spawnfile/agents/:slug/wake is the operator-only mutating endpoint
// gated by a bearer token below — the only mutating control endpoint gated
// today (see AGENTS.md / B62 for why the load/restart dev-reload endpoints
// stay out of this slice's scope). POST /agents/:slug/wake is the loopback
// Moltnet->Pi delivery endpoint (server.listen("127.0.0.1") below): it is
// NOT operator-only, is never gated by this token, and stamps a different
// principal (system:moltnet, never operator:control) — see the delivery
// handler further down. SPAWNFILE_PI_CONTROL_TOKEN is trusted env minted by
// the generator/harness (same trust shape as SPAWNFILE_PI_CONTROL_PORT and
// NOOPOLIS_RUN_ID, src/runtime/common.ts) — read only from process.env,
// NEVER from the request body, headers content, or model output. When the
// env var is unset there is "no operator configured": every operator wake
// request fails closed with 401, it is never treated as "auth disabled".
const CONTROL_TOKEN_ENV = "SPAWNFILE_PI_CONTROL_TOKEN";

// The authenticated principal stamped on control.wake.accepted/denied
// events for this endpoint (operator:control, specs/CAUSAL.md §3). Root
// has exactly one operator-control bearer token today, so one static
// operator identity is enough; a future multi-operator token scheme would
// resolve this from the verified token instead.
const CONTROL_OPERATOR_NAME = "control";

const controlWakeRequestId = (targetAgentId) =>
  "wake-" + targetAgentId + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);

const extractBearerToken = (request) => {
  const header = request.headers && (request.headers.authorization ?? request.headers.Authorization);
  if (typeof header !== "string") {
    return "";
  }
  const match = /^Bearer\s+(.+)$/u.exec(header.trim());
  return match ? match[1].trim() : "";
};

/**
 * Authorizes a mutating wake request against SPAWNFILE_PI_CONTROL_TOKEN.
 * Fails closed (ok: false) on every path: no configured token, no bearer
 * header, or a bearer value that does not match — there is no "auth
 * disabled" state.
 */
const authorizeControlWake = (request) => {
  const configuredToken = typeof process.env[CONTROL_TOKEN_ENV] === "string" ? process.env[CONTROL_TOKEN_ENV].trim() : "";
  if (!configuredToken) {
    return { ok: false, reason: "no operator token configured (" + CONTROL_TOKEN_ENV + " is unset)" };
  }

  const providedToken = extractBearerToken(request);
  if (!providedToken) {
    return { ok: false, reason: "missing bearer token" };
  }
  if (providedToken !== configuredToken) {
    return { ok: false, reason: "invalid bearer token" };
  }

  return { ok: true };
};

/**
 * B62 enforcement point #3 (specs/CAUSAL.md): stamps control.wake.denied
 * for a rejected wake request via daimon's observability emitters. Never
 * lets a telemetry write failure break the HTTP 401 response — this is
 * best-effort like every other causal stamp in this generated app.
 */
const recordControlWakeDenied = async (reason, targetAgentId, runtimeHomePath, requestId) => {
  try {
    await emitControlWakeDenied({
      operatorName: CONTROL_OPERATOR_NAME,
      reason,
      requestId,
      runtimeHomePath,
      targetAgentId
    });
  } catch (error) {
    console.error("[pi] failed to record control.wake.denied: " + (error instanceof Error ? error.message : String(error)));
  }
};

/** B62 enforcement point #3, operator path: stamps control.wake.accepted (principal operator:control) for an authorized, executed wake. */
const recordControlWakeAccepted = async (targetAgentId, wakeKind, runtimeHomePath, requestId) => {
  try {
    await emitControlWakeAccepted({
      operatorName: CONTROL_OPERATOR_NAME,
      requestId,
      runtimeHomePath,
      targetAgentId,
      wakeKind
    });
  } catch (error) {
    console.error("[pi] failed to record control.wake.accepted: " + (error instanceof Error ? error.message : String(error)));
  }
};

/**
 * B62 enforcement point #3, Moltnet delivery path (Option B): stamps
 * control.wake.accepted for a tokenless delivery wake via daimon's
 * emitDeliveryWakeAccepted, which always stamps principal_id "system:moltnet"
 * — the delivering authority itself — NEVER operator:control, and NEVER a
 * value read from the request body's "from"/agent field. This is the
 * attribution that distinguishes a real inter-agent delivery from an
 * operator-issued wake without needing a second bearer token.
 */
const recordDeliveryWakeAccepted = async (targetAgentId, wakeKind, runtimeHomePath, requestId) => {
  try {
    await emitDeliveryWakeAccepted({
      requestId,
      runtimeHomePath,
      targetAgentId,
      wakeKind
    });
  } catch (error) {
    console.error("[pi] failed to record delivery control.wake.accepted: " + (error instanceof Error ? error.message : String(error)));
  }
};

/**
 * Shared wake-execution core for both /agents/:slug/wake (delivery) and
 * /spawnfile/agents/:slug/wake (operator): reads the request body, runs
 * the agent's wake, and returns the response shape both endpoints send.
 * A blank/missing message is treated as a no-op (matches pre-B62 behavior)
 * and is reported as executed: false so callers skip the causal stamp for
 * it, exactly like the original single-endpoint handler did. Auth and
 * attribution (which principal to stamp) are the caller's responsibility —
 * this helper has no knowledge of either.
 */
const executeAgentWake = async (agent, payload) => {
  if (typeof payload.message !== "string" || payload.message.trim().length === 0) {
    return { executed: false, from: agent.config.id, message: "", wakeKind: undefined };
  }

  const eventId = formatControlEventId(payload, "message-");
  const wakeKind = normalizeWakeKind(typeof payload.wake_kind === "string" ? payload.wake_kind : payload.kind);
  const message = await agent.wake({
    id: eventId,
    kind: wakeKind,
    from: typeof payload.from === "string" ? payload.from : "moltnet",
    context: payload.context && typeof payload.context === "object" ? payload.context : undefined,
    context_id: typeof payload.context_id === "string" ? payload.context_id : undefined,
    text: typeof payload.message === "string" ? payload.message : ""
  });

  return { executed: true, from: agent.config.id, message, wakeKind };
};

const loadManagedAgent = async (agents, configPath, slug, instanceRoot, services) => {
  const config = await readJson(configPath);
  const agentConfig = (config.agents ?? []).find((agent) => agent.slug === slug || agent.id === slug || agent.name === slug);
  if (!agentConfig) {
    throw new Error("unknown agent " + slug);
  }

  const oldIndex = agents.findIndex((agent) => agent.config.slug === agentConfig.slug || agent.config.id === agentConfig.id || agent.config.name === agentConfig.name);
  if (oldIndex >= 0) {
    agents[oldIndex].stop();
    agents.splice(oldIndex, 1);
  }

  const managed = new PiManagedAgent(agentConfig, {
    runtimeHomePath: path.join(instanceRoot, "runtime", "agents", agentConfig.slug),
    homePath: path.join(instanceRoot, "home"),
    workspacePath: path.join(instanceRoot, "workspace", "agents", agentConfig.slug)
  }, services);
  await managed.start();
  agents.push(managed);
  return managed;
};

const startControlServer = async (agents, portValue, configPath, instanceRoot, services) => {
  if (!portValue) {
    return null;
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Invalid SPAWNFILE_PI_CONTROL_PORT: " + portValue);
  }

  let agentsByKey = rebuildAgentKeys(agents);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/spawnfile/agents") {
      sendJson(response, 200, {
        agents: agents.map((agent) => ({
          id: agent.config.id,
          name: agent.config.name,
          slug: agent.config.slug
        }))
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/spawnfile/activity") {
      sendJson(response, 200, { events: services.activity.list(url.searchParams.get("agent"), url.searchParams.get("tail")) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/spawnfile/activity/stream") {
      services.activity.stream(request, response, url.searchParams.get("agent"), url.searchParams.get("tail"));
      return;
    }

    const activityMatch = /^\/spawnfile\/agents\/([^/]+)\/activity(\/stream)?$/u.exec(url.pathname);
    if (request.method === "GET" && activityMatch) {
      const agentFilter = decodeURIComponent(activityMatch[1]);
      if (activityMatch[2]) {
        services.activity.stream(request, response, agentFilter, url.searchParams.get("tail"));
      } else {
        sendJson(response, 200, { events: services.activity.list(agentFilter, url.searchParams.get("tail")) });
      }
      return;
    }

    if (request.method === "POST" && (url.pathname === "/spawnfile/agents/load" || url.pathname === "/spawnfile/agents/restart")) {
      try {
        const payload = await readRequestJson(request);
        const slug = typeof payload.slug === "string"
          ? payload.slug
          : typeof payload.agent === "string"
            ? payload.agent
            : "";
        const agent = await loadManagedAgent(agents, configPath, slug, instanceRoot, services);
        agentsByKey = rebuildAgentKeys(agents);
        sendJson(response, 200, { id: agent.config.id, loaded: true, name: agent.config.name, slug: agent.config.slug });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // B62 Option B, operator path: fail-closed on SPAWNFILE_PI_CONTROL_TOKEN,
    // stamps operator:control via emitControlWakeAccepted/Denied. This is the
    // ONLY wake path gated by a bearer token.
    const operatorWakeMatch = /^\/spawnfile\/agents\/([^/]+)\/wake$/u.exec(url.pathname);
    if (request.method === "POST" && operatorWakeMatch) {
      const key = decodeURIComponent(operatorWakeMatch[1]);
      const requestId = controlWakeRequestId(key);

      const authResult = authorizeControlWake(request);
      if (!authResult.ok) {
        const knownAgent = agentsByKey.get(key);
        const deniedRuntimeHomePath = knownAgent
          ? knownAgent.paths.runtimeHomePath
          : path.join(instanceRoot, "runtime", "control");
        await recordControlWakeDenied(authResult.reason, key, deniedRuntimeHomePath, requestId);
        sendJson(response, 401, { error: authResult.reason });
        return;
      }

      const agent = agentsByKey.get(key);
      if (!agent) {
        sendJson(response, 404, { error: "unknown agent " + key });
        return;
      }

      try {
        const payload = await readRequestJson(request);
        const result = await executeAgentWake(agent, payload);
        if (result.executed) {
          await recordControlWakeAccepted(key, result.wakeKind, agent.paths.runtimeHomePath, requestId);
        }
        sendJson(response, 200, { from: result.from, message: result.message });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // B62 Option B, Moltnet delivery path: the loopback (127.0.0.1) endpoint
    // the Moltnet->Pi bridge POSTs normal inter-agent deliveries to. NOT
    // operator-only, NEVER gated by SPAWNFILE_PI_CONTROL_TOKEN (sender
    // authority is already enforced moltnet-side before a message reaches
    // here), and stamps principal_id "system:moltnet" via
    // recordDeliveryWakeAccepted — NEVER operator:control, and NEVER read
    // from the request body's "from"/agent field.
    const deliveryWakeMatch = /^\/agents\/([^/]+)\/wake$/u.exec(url.pathname);
    if (request.method !== "POST" || !deliveryWakeMatch) {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    const deliveryKey = decodeURIComponent(deliveryWakeMatch[1]);
    const deliveryRequestId = controlWakeRequestId(deliveryKey);

    const deliveryAgent = agentsByKey.get(deliveryKey);
    if (!deliveryAgent) {
      sendJson(response, 404, { error: "unknown agent " + deliveryKey });
      return;
    }

    try {
      const payload = await readRequestJson(request);
      const result = await executeAgentWake(deliveryAgent, payload);
      if (result.executed) {
        await recordDeliveryWakeAccepted(deliveryKey, result.wakeKind, deliveryAgent.paths.runtimeHomePath, deliveryRequestId);
      }
      sendJson(response, 200, { from: result.from, message: result.message });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log("[pi] control listening on 127.0.0.1:" + port);
  return server;
};
