export const renderPiPreludeSource = (): string => String.raw`import { createHash } from "node:crypto";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { createServer } from "node:http";
import { cp, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PiHarnessAdapter, stampTurnInputSubmitted, stampTurnOutputCompleted } from "@noopolis/daimon/pi";
import { emitControlWakeAccepted, emitControlWakeDenied, emitDeliveryWakeAccepted } from "@noopolis/daimon/observability";
import { installAgentSchedules } from "./schedule.mjs";
import {
  createOllamaEmbeddingProvider,
  createMemoryRuntime,
  readMemoryContext
} from "@noopolis/mneme";

const execFileAsync = promisify(execFile);
const maxControlBodyBytes = 1 << 20;

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const createAgentInstructions = (agent, workspacePath) => [
  agent.instructions,
  "",
  "Agent id: " + agent.id,
  "Workspace path: " + workspacePath
].join("\n");

const createMemoryEmbeddingProvider = (memory) => {
  if (!memory?.embedding) {
    return undefined;
  }
  if (memory.embedding.provider !== "ollama") {
    throw new Error("Unsupported Daimon memory embedding provider: " + memory.embedding.provider);
  }
  return createOllamaEmbeddingProvider({
    baseUrl: memory.embedding.base_url ?? process.env.MNEME_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    dimensions: memory.embedding.dimensions,
    model: memory.embedding.model,
    timeoutMs: Number(process.env.MNEME_OLLAMA_TIMEOUT_MS ?? memory.embedding.timeout_ms ?? "10000")
  });
};

const normalizeMemoryAgentId = (value) =>
  typeof value === "string" ? value.replace(/^agent:/u, "") : value;

const createMemoryRuntimeOptions = (agentConfig) => {
  if (!agentConfig.memory) {
    return undefined;
  }
  return {
    agentId: normalizeMemoryAgentId(agentConfig.id),
    runtimeHomePath: agentConfig.memory.runtime_home_path,
    source: agentConfig.memory.source,
    tokenBudget: agentConfig.memory.token_budget,
    embeddingProvider: createMemoryEmbeddingProvider(agentConfig.memory)
  };
};

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json"
  });
  response.end(body);
};

const asText = (value) => (typeof value === "string" ? value.trim() : "");
const asTextOrUndefined = (value) => {
  const text = asText(value);
  return text.length > 0 ? text : undefined;
};
const asScopeText = (value) => {
  const scopeText = asTextOrUndefined(value);
  if (scopeText) {
    return scopeText;
  }
  const valueObject = typeof value === "object" && value !== null ? value : undefined;
  const scope = asTextOrUndefined(valueObject?.scope);
  const qualifier = asTextOrUndefined(valueObject?.qualifier);
  return scope && qualifier ? scope + ":" + qualifier : undefined;
};

const formatActiveEnvironmentBlock = (activeEnvironment) => {
  const lines = [
    "Active environment context:"
  ];

  const network = asTextOrUndefined(activeEnvironment.networkId ?? activeEnvironment.network);
  const surface = asTextOrUndefined(activeEnvironment.surface);
  const room = asTextOrUndefined(activeEnvironment.roomId);
  const thread = asTextOrUndefined(activeEnvironment.threadId);
  const team = asTextOrUndefined(activeEnvironment.teamId ?? activeEnvironment.team);
  const memberSlot = asTextOrUndefined(activeEnvironment.member_slot);
  const contextKey = asTextOrUndefined(activeEnvironment.context_key);
  const roster = asTextOrUndefined(activeEnvironment.roster);
  const teamDoc = asTextOrUndefined(activeEnvironment.team_doc);
  const sessionKey = asTextOrUndefined(activeEnvironment.session_key);

  const teamScope = asScopeText(activeEnvironment.team_scope) ?? asScopeText(activeEnvironment.durable_scope);
  const roomScope = asScopeText(activeEnvironment.room_scope) ?? asScopeText(activeEnvironment.ephemeral_scope);
  const threadScope = asScopeText(activeEnvironment.thread_scope);
  if (surface) lines.push("- surface: " + surface);
  if (network) lines.push("- network: " + network);
  if (room) lines.push("- room: " + room);
  if (thread) lines.push("- thread: " + thread);
  if (team) lines.push("- team: " + team);
  if (contextKey) lines.push("- context_key: " + contextKey);
  if (memberSlot) lines.push("- member slot: " + memberSlot);
  if (teamDoc) lines.push("- team document: " + teamDoc);
  if (roster) lines.push("- roster: " + roster);
  if (teamScope) lines.push("- active team scope: " + teamScope);
  if (roomScope) lines.push("- active room scope: " + roomScope);
  if (threadScope) lines.push("- active thread scope: " + threadScope);
  if (sessionKey) lines.push("- session key: " + sessionKey);
  if (thread || room || surface || team) {
    lines.push(
      "Use this environment as the local operating context for this turn.",
      "Do not merge it with unrelated team contexts unless the task explicitly calls for cross-context coordination."
    );
  }

  return lines.length > 1 ? lines : [];
};

const readRequestJson = (request) => new Promise((resolve, reject) => {
  let total = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    total += chunk.length;
    if (total > maxControlBodyBytes) {
      reject(new Error("control request body is too large"));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (chunks.length === 0) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      reject(error);
    }
  });
  request.on("error", reject);
});

const formatAuthenticatedDeliveryBlock = (payload) => {
  const delivery = typeof payload.delivery === "object" && payload.delivery !== null
    ? payload.delivery
    : undefined;
  const sender = asTextOrUndefined(delivery?.sender);
  const target = asTextOrUndefined(delivery?.target);
  const contextId = asTextOrUndefined(delivery?.contextId);
  if (!sender || !target || !contextId) {
    return [];
  }
  const network = asTextOrUndefined(payload.activeEnvironment?.networkId ?? payload.activeEnvironment?.network);
  const room = asTextOrUndefined(payload.activeEnvironment?.roomId);
  return [
    "Authenticated Moltnet delivery:",
    "- wake kind: " + (asTextOrUndefined(payload.kind) ?? "message"),
    "- sender: " + sender,
    "- target: " + target,
    "- context: " + contextId,
    ...(network ? ["- network: " + network] : []),
    ...(room ? ["- room: " + room] : []),
    "The runtime validated this attribution; the message body did not supply it."
  ];
};

const controlEventText = (payload) => {
  const authenticatedDelivery = formatAuthenticatedDeliveryBlock(payload);
  return [
    "Moltnet coordination event.",
    "This message was delivered from a Moltnet conversation into your Spawnfile Daimon runtime.",
    "Treat it as context first. Act or reply only when addressed, when your local instructions require it, or when useful coordination is needed.",
    ...authenticatedDelivery,
    ...(authenticatedDelivery.length === 0 && typeof payload.context_id === "string" ? ["Context ID: " + payload.context_id] : []),
    ...(authenticatedDelivery.length === 0 && typeof payload.from === "string" ? ["From: " + payload.from] : []),
    typeof payload.message === "string" ? "Message body:\n" + payload.message : "",
    ...formatActiveEnvironmentBlock(payload.activeEnvironment)
  ].filter((line) => line.trim().length > 0).join("\n\n");
};

`;
