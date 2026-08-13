import { renderPiControlSource } from "./appControlSource.js";
import { renderPiWakeContextSource } from "./appWakeContextSource.js";

export interface RenderPiCoreSourceOptions {
  world?: boolean;
}

export const renderPiCoreSource = (
  options: RenderPiCoreSourceOptions = {}
): string => String.raw`const createConfigModel = (agentConfig) => ({
  provider: typeof agentConfig?.model?.provider === "string" ? agentConfig.model.provider : "openai-codex",
  name: typeof agentConfig?.model?.name === "string" ? agentConfig.model.name : "gpt-5.4-mini"
});

const normalizeWakeKind = (value) => {
  return value === "manual" || value === "message" || value === "schedule" || value === "dream"
    ? value
    : "message";
};

${renderPiWakeContextSource()}

${renderPiControlSource()}

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
          model: createConfigModel(config),
          memory: createMemoryRuntimeOptions(config),
          rawTrainingCapture: config.raw_training_capture,
          thinkingLevel: config.thinking_level${options.world ? ",\n          world: config.world" : ""}
        })
      : null;
    this.running = false;
    this.queued = [];
  }
  async start() {
    if (this.engine === "pi") {
      this.handle = await this.adapter.startAgent({
        id: this.config.id,
        name: this.config.name,
        instructions: createAgentInstructions(this.config, this.paths.workspacePath),
        runtimeHomePath: this.paths.runtimeHomePath,
        tools: this.config.tools,
        workspacePath: this.paths.workspacePath
      });
    } else {
      this.handle = new CliEngineAgentHandle(this.config, this.paths);
    }
    this.publish("agent.loaded", { engine: this.engine });
  }
  listDreamEnvironmentKeys() {
    return listDreamEnvironmentKeys(this.paths.workspacePath);
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
    const enriched = await enrichWakeContext(this.paths.workspacePath, event);
    const messageFrom = asStringOrUndefined(enriched.messageFrom);
    const isRoomWake = enriched.isRoomWake;
    const deliveryFrom = asStringOrUndefined(event.delivery?.sender);
    const from = deliveryFrom ?? (isRoomWake
      ? "moltnet"
      : (asStringOrUndefined(enriched.eventFrom) ?? messageFrom ?? "moltnet"));
    const kind = normalizeWakeKind(event.kind);
    const rawText = typeof event.text === "string" ? event.text : "";
    const resolvedContext = enriched.context;
    const context = asObject(resolvedContext) ? {
      ...resolvedContext,
      activeEnvironment: enriched.activeEnvironment,
      active_environment: enriched.activeEnvironment
    } : enriched.context;
    const promptFrom = isRoomWake ? messageFrom : from;
    const contextualText = kind === "message" || kind === "manual"
      ? controlEventText({ ...event, message: rawText, from: promptFrom, activeEnvironment: enriched.activeEnvironment })
      : [
          rawText,
          ...formatActiveEnvironmentBlock(enriched.activeEnvironment)
        ].filter((line) => line.trim().length > 0).join("\n\n");

    const enrichedEvent = {
      ...event,
      context,
      from,
      text: contextualText,
    };

    return new Promise((resolve, reject) => {
      this.queued.push({ event: enrichedEvent, reject, resolve });
      this.publish("agent.wake.queued", {
        queue_length: this.queued.length,
        wake_id: event.id,
        wake_kind: kind
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
        context: event.context,
        context_id: event.context_id,
        delivery: event.delivery,
        id: event.id,
        kind: event.kind,
        from: event.from,
        text: event.text,
        transportText: event.transportText
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
        trace_path: turnTracePath(this.paths, event.id),
        wake_id: event.id,
        wake_kind: event.kind
      });
      return finalText;
    } catch (error) {
      console.error("[pi:" + this.config.id + "] failed " + event.id + ": " + (error instanceof Error ? error.message : String(error)));
      this.publish("agent.turn.failed", {
        duration_ms: Date.now() - startedAt,
        error: formatActivityError(error),
        trace_path: turnTracePath(this.paths, event.id),
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
  const activityLogPath = path.join(instanceRoot, "runtime", "activity.ndjson");
  await mkdir(path.dirname(activityLogPath), { recursive: true });
  const activity = createActivityBroker({ logPath: activityLogPath });
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

  const scheduledCount = await installAgentSchedules(agents, timers, runOnce);

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
