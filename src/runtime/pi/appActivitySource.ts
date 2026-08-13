export const renderPiActivitySource = (): string => String.raw`
const maxActivityEvents = 500;

const createActivityBroker = (options = {}) => {
  let sequence = 0;
  const events = [];
  const clients = new Set();

  const normalizeFilter = (value) => typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
  const matchesFilter = (event, filter) => {
    const normalized = normalizeFilter(filter);
    return normalized === "" ||
      event.agent_id === normalized ||
      event.agent_slug === normalized ||
      event.agent_name === normalized ||
      event.agent_id === "agent:" + normalized;
  };
  const parseTail = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : maxActivityEvents;
  };

  const publish = (event) => {
    const full = {
      version: "spawnfile.activity.v1",
      sequence: ++sequence,
      created_at: new Date().toISOString(),
      ...event
    };
    events.push(full);
    if (events.length > maxActivityEvents) {
      events.splice(0, events.length - maxActivityEvents);
    }
    if (typeof options.logPath === "string" && options.logPath.length > 0) {
      appendFileSync(options.logPath, JSON.stringify(full) + "\n", "utf8");
    }
    const frame = "data: " + JSON.stringify(full) + "\n\n";
    for (const client of [...clients]) {
      if (!matchesFilter(full, client.filter)) {
        continue;
      }
      try {
        client.response.write(frame);
      } catch {
        clients.delete(client);
      }
    }
    return full;
  };

  const list = (filter, tail) => {
    const selected = events.filter((event) => matchesFilter(event, filter));
    return selected.slice(Math.max(0, selected.length - parseTail(tail)));
  };

  const stream = (request, response, filter, tail) => {
    response.writeHead(200, {
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream"
    });
    response.write("event: ready\ndata: {\"status\":\"ok\"}\n\n");
    for (const event of list(filter, tail)) {
      response.write("data: " + JSON.stringify(event) + "\n\n");
    }
    const client = { filter: normalizeFilter(filter), response };
    clients.add(client);
    request.on("close", () => clients.delete(client));
  };

  return { list, publish, stream };
};

const redactActivityText = (value) => {
  let redacted = String(value);
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/\bmagt_v1_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
  redacted = redacted.replace(/\b(?:sk|sk-proj)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
  redacted = redacted.replace(
    /("([^"]*(?:api[_-]?key|authorization|credential|password|secret|session[_-]?key|token)[^"]*)"\s*:\s*")([^"]+)(")/gi,
    "$1[REDACTED]$4"
  );
  redacted = redacted.replace(
    /\b((?:api[_-]?key|authorization|credential|password|secret|session\s+key|session[_-]?key|token)\s*[:=]\s*)([^\r\n]+)/gi,
    "$1[REDACTED]"
  );
  redacted = redacted.replace(/\/(?:Users|home|private|tmp|var|opt|run)\/[^\s"']+/g, "[path]");
  return redacted.length > 1000 ? redacted.slice(0, 1000) + "..." : redacted;
};

const formatActivityError = (error) => redactActivityText(error instanceof Error ? error.message : String(error));

const traceSha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const sensitiveTraceKeyPattern = /(?:api[_-]?key|authorization|credential|password|secret|session[_-]?key|token)/iu;

const sanitizeTraceValue = (value, key = "") => {
  if (value === null || value === undefined) {
    return value;
  }
  if (sensitiveTraceKeyPattern.test(String(key))) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactActivityText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTraceValue(entry));
  }
  if (typeof value === "object") {
    const sanitized = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      sanitized[entryKey] = sanitizeTraceValue(entryValue, entryKey);
    }
    return sanitized;
  }
  return redactActivityText(String(value));
};

const summarizeTurnPrompt = (prompt) => ({
  chars: typeof prompt === "string" ? prompt.length : 0,
  has_active_environment: typeof prompt === "string" && prompt.includes("Active environment context:"),
  has_dream_mode: typeof prompt === "string" && prompt.includes("## Dream Mode"),
  has_memory_context: typeof prompt === "string" && prompt.includes("Memory context"),
  lines: typeof prompt === "string" && prompt.length > 0 ? prompt.split(/\r?\n/u).length : 0,
  sha256: traceSha256(typeof prompt === "string" ? prompt : "")
});

const sanitizeTraceFileId = (value) => {
  const normalized = String(value).replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 128);
  return normalized.length > 0 ? normalized : "turn";
};

const turnTracePath = (paths, wakeId) =>
  path.join(paths.runtimeHomePath, "telemetry", "turns", sanitizeTraceFileId(wakeId) + ".json");

const writeTurnTrace = async (paths, record) => {
  const telemetryPath = path.join(paths.runtimeHomePath, "telemetry");
  const turnsPath = path.join(telemetryPath, "turns");
  await mkdir(turnsPath, { recursive: true });
  await writeFile(turnTracePath(paths, record.turn_id), JSON.stringify(record, null, 2) + "\n", "utf8");
  await writeFile(path.join(telemetryPath, "turns.ndjson"), JSON.stringify(record) + "\n", { flag: "a" });
};

const createGeneratedTurnTrace = (input) => ({
  agent_id: input.config.id,
  completed_at: new Date().toISOString(),
  engine: {
    auth_method: input.config.model?.auth_method ?? "unknown",
    kind: input.engine,
    model: input.config.model?.name ?? "unknown",
    provider: input.config.model?.provider ?? "unknown"
  },
  ...(input.error ? { error: { message: formatActivityError(input.error), stage: input.errorStage ?? "wake" } } : {}),
  memory: {
    enabled: Boolean(input.config.memory),
    ...(input.memoryPrepareMs !== undefined || input.memoryRecall ? {
      prepare: {
        duration_ms: input.memoryPrepareMs ?? 0,
        ...(input.memoryRecall ? { recall: input.memoryRecall } : {}),
        status: input.memoryPrepareStatus ?? "completed"
      }
    } : {}),
    ...(input.memoryRecordMs !== undefined ? { record_ms: input.memoryRecordMs } : {})
  },
  prompt: summarizeTurnPrompt(input.prompt),
  reply: {
    output_chars: input.outputText.length,
    reply_given: input.outputText.trim().length > 0
  },
  schema: "daimon.turn_trace.v1",
  session: {
    mode: input.event.kind === "dream" ? "dream" : "awake",
    thread_id: input.event.context_id ? redactActivityText(input.event.context_id) : input.event.id
  },
  started_at: input.startedAt.toISOString(),
  status: input.status,
  timings_ms: {
    ...(input.engineMs !== undefined ? { engine_prompt: input.engineMs } : {}),
    ...(input.memoryPrepareMs !== undefined ? { memory_prepare: input.memoryPrepareMs } : {}),
    ...(input.memoryRecordMs !== undefined ? { memory_record: input.memoryRecordMs } : {}),
    total: Date.now() - input.startedAt.getTime()
  },
  tools: [],
  turn_id: input.event.id,
  wake: {
    ...(input.event.context ? { context: sanitizeTraceValue(input.event.context) } : {}),
    ...(input.event.context_id ? { context_id: redactActivityText(input.event.context_id) } : {}),
    event_id: input.event.id,
    ...(input.event.from ? { from: redactActivityText(input.event.from) } : {}),
    kind: input.event.kind
  }
});
`;
