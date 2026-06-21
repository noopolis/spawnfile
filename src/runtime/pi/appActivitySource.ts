export const renderPiActivitySource = (): string => String.raw`
const maxActivityEvents = 500;

const createActivityBroker = () => {
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
    /("([^"]*(?:api[_-]?key|token|secret|password)[^"]*)"\s*:\s*")([^"]+)(")/gi,
    "$1[REDACTED]$4"
  );
  redacted = redacted.replace(/\/(?:Users|home|private|tmp|var|opt|run)\/[^\s"']+/g, "[path]");
  return redacted.length > 1000 ? redacted.slice(0, 1000) + "..." : redacted;
};

const formatActivityError = (error) => redactActivityText(error instanceof Error ? error.message : String(error));
`;
