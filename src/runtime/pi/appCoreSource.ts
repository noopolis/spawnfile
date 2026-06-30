export const renderPiCoreSource = (): string => String.raw`const createConfigModel = (agentConfig) => ({
  provider: typeof agentConfig?.model?.provider === "string"
    ? agentConfig.model.provider
    : "openai-codex",
  name: typeof agentConfig?.model?.name === "string"
    ? agentConfig.model.name
    : "gpt-5.4-mini"
});

const normalizeWakeKind = (value) => {
  return value === "manual" || value === "message" || value === "schedule"
    ? value
    : "message";
};

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

    const match = /^\/agents\/([^/]+)\/wake$/u.exec(url.pathname);
    if (request.method !== "POST" || !match) {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    const key = decodeURIComponent(match[1]);
    const agent = agentsByKey.get(key);
    if (!agent) {
      sendJson(response, 404, { error: "unknown agent " + key });
      return;
    }

    try {
      const payload = await readRequestJson(request);
      if (typeof payload.message !== "string" || payload.message.trim().length === 0) {
        sendJson(response, 200, { from: agent.config.id, message: "" });
        return;
      }
      const eventId = formatControlEventId(payload, "message-");
      const message = await agent.wake({
        id: eventId,
        kind: normalizeWakeKind(typeof payload.wake_kind === "string" ? payload.wake_kind : payload.kind),
        from: typeof payload.from === "string" ? payload.from : "moltnet",
        text: controlEventText(payload)
      });

      sendJson(response, 200, {
        from: agent.config.id,
        message
      });
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

class PiManagedAgent {
  constructor(config, paths, services) {
    this.config = config;
    this.paths = paths;
    this.services = services;
    this.engine = normalizeAgentEngineKind(config);
    this.adapter = this.engine === "pi"
      ? new PiHarnessAdapter({
          authPath: path.join(paths.homePath, ".pi", "agent", "auth.json"),
          modelsPath: path.join(paths.homePath, ".pi", "agent", "models.json"),
          model: createConfigModel(config)
        })
      : null;
    this.running = false;
    this.queued = [];
  }
  async start() {
    if (this.engine === "pi") {
      const identityPrompt = createIdentityPrompt(this.config, this.paths.workspacePath);
      this.handle = await this.adapter.startAgent({
        id: this.config.id,
        name: this.config.name,
        instructions: this.config.instructions + "\n\n" + identityPrompt,
        runtimeHomePath: this.paths.runtimeHomePath,
        tools: this.config.tools,
        workspacePath: this.paths.workspacePath
      });
    } else {
      this.handle = new CliEngineAgentHandle(this.config, this.paths);
    }
    this.publish("agent.loaded", { engine: this.engine });
  }
  publish(type, fields = {}) {
    this.services.activity?.publish({
      type,
      agent_id: this.config.id,
      agent_name: this.config.name,
      agent_slug: this.config.slug,
      engine: this.engine,
      ...fields
    });
  }
  async wake(event) {
    return new Promise((resolve, reject) => {
      this.queued.push({ event, reject, resolve });
      this.publish("agent.wake.queued", {
        queue_length: this.queued.length,
        wake_id: event.id,
        wake_kind: event.kind
      });
      void this.drainQueue();
    });
  }
  async drainQueue() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.queued.length > 0) {
        const next = this.queued.shift();
        try {
          next.resolve(await this.runWake(next.event));
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
  async runWake(event) {
    const startedAt = Date.now();
    this.publish("agent.turn.started", {
      wake_id: event.id,
      wake_kind: event.kind
    });
    try {
      const result = await this.handle.wake({
        id: event.id,
        kind: event.kind,
        from: event.from,
        text: event.text
      });
      const finalText = typeof result.text === "string" ? result.text.trim() : "";
      console.log("[pi:" + this.config.id + "] " + finalText);
      if (finalText.length > 0) {
        this.publish("agent.output.completed", {
          text: finalText,
          wake_id: event.id,
          wake_kind: event.kind
        });
      }
      this.publish("agent.turn.completed", {
        duration_ms: result.durationMs ?? (Date.now() - startedAt),
        output_length: finalText.length,
        wake_id: event.id,
        wake_kind: event.kind
      });
      return finalText;
    } catch (error) {
      console.error("[pi:" + this.config.id + "] failed " + event.id + ": " + (error instanceof Error ? error.message : String(error)));
      this.publish("agent.turn.failed", {
        duration_ms: Date.now() - startedAt,
        error: formatActivityError(error),
        wake_id: event.id,
        wake_kind: event.kind
      });
      throw error;
    }
  }
  stop() {
    this.handle?.stop();
    this.publish("agent.stopped");
  }
}

const main = async () => {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error("Usage: node app.mjs <pi-app.json>");
  }

  const config = await readJson(configPath);
  const instanceRoot = path.resolve(path.dirname(configPath), "..");
  const activity = createActivityBroker();
  const services = { activity };
  const agents = [];

  for (const agentConfig of config.agents ?? []) {
    const managed = new PiManagedAgent(
      agentConfig,
      {
      runtimeHomePath: path.join(instanceRoot, "runtime", "agents", agentConfig.slug),
        homePath: path.join(instanceRoot, "home"),
        workspacePath: path.join(instanceRoot, "workspace", "agents", agentConfig.slug)
      },
      services
    );
    await managed.start();
    agents.push(managed);
  }

  const timers = [];
  const runOnce = process.env.SPAWNFILE_PI_RUN_ONCE === "1";
  const controlServer = runOnce
    ? null
    : await startControlServer(agents, process.env.SPAWNFILE_PI_CONTROL_PORT, configPath, instanceRoot, services);

  let scheduledCount = 0;
  for (const agent of agents) {
    if (agent.config.schedule?.kind !== "every" || !agent.config.schedule.every) {
      continue;
    }

    const intervalMs = parseEveryMs(agent.config.schedule.every);
    const createEvent = () => ({
      id: "schedule-" + agent.config.id + "-" + Date.now(),
      kind: "schedule",
      from: "scheduler",
      text: agent.config.schedule.prompt ?? "Run the scheduled Spawnfile task."
    });
    scheduledCount += 1;

    if (runOnce) {
      await agent.wake(createEvent());
      continue;
    }

    const timer = setInterval(() => {
      void agent.wake(createEvent()).catch((error) => {
        console.error("[pi:" + agent.config.id + "] scheduled wake error: " + (error instanceof Error ? error.message : String(error)));
      });
    }, intervalMs);
    timers.push(timer);

    setTimeout(() => {
      void agent.wake(createEvent()).catch((error) => {
        console.error("[pi:" + agent.config.id + "] initial wake error: " + (error instanceof Error ? error.message : String(error)));
      });
    }, 100);
  }

  if (runOnce) {
    if (scheduledCount === 0) {
      console.log("[pi] no schedules to run");
    }
    for (const agent of agents) {
      agent.stop();
    }
    return;
  }

  console.log("[pi] started " + agents.length + " agents");
  const shutdown = () => {
    for (const timer of timers) {
      clearInterval(timer);
    }
    for (const agent of agents) {
      agent.stop();
    }
    controlServer?.close(() => process.exit(0));
    if (!controlServer) {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
`;
