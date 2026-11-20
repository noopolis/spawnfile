import { posix } from "node:path";
import type { Observation } from "../trainingTypes.js";
import { RUNTIME_INSTALL_ROOT } from "../container.js";
import type {
  NativeTrainingDriver,
  NativeTrainingInstance,
  NativeTrainingTurn
} from "../nativeTraining.js";

type NativeRecord = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const NATIVE_ID = /^[\w.:-]{1,256}$/;
const COMPLETED = new Set(["stop", "end_turn", "completed"]);
const MAX_TRANSCRIPT_CHARS = 8 * 1024 * 1024;
const SYNTHETIC_TOOL_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";

function record(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as NativeRecord
    : undefined;
}

function parseRecord(raw: string): NativeRecord | undefined {
  try {
    return record(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function nativeId(value: unknown): value is string {
  return typeof value === "string" && NATIVE_ID.test(value);
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("OpenClaw training turn cancelled", "AbortError");
}

function terminalText(stdout: string, sessionId: string): string {
  // v2026.6.11 agent --local --json emits delivery.ts's result envelope.
  // Parsing all stdout as one document prevents promotion of JSON-looking log lines.
  const reply = parseRecord(stdout);
  const meta = record(reply?.meta);
  const agent = record(meta?.agentMeta);
  const stopReason = meta?.stopReason;
  if (!reply || reply.status !== undefined || agent?.sessionId !== sessionId ||
      !Array.isArray(reply.payloads) || !meta ||
      typeof meta.durationMs !== "number" || !Number.isFinite(meta.durationMs) ||
      meta.durationMs < 0 || meta.error != null || meta.failureSignal != null ||
      meta.timeoutPhase != null || meta.aborted || meta.yielded ||
      // A completed write makes retrying the turn unsafe. Its original reply is still valid.
      (meta.replayInvalid && !COMPLETED.has(String(stopReason))) ||
      meta.agentHarnessResultClassification != null ||
      (stopReason !== undefined && (typeof stopReason !== "string" || !COMPLETED.has(stopReason))) ||
      (Array.isArray(meta.pendingToolCalls) && meta.pendingToolCalls.length > 0)) {
    throw new Error("OpenClaw returned no correlated completed reply");
  }

  const parts: string[] = [];
  for (const value of reply.payloads) {
    const payload = record(value);
    if (!payload || payload.isError) {
      throw new Error("OpenClaw returned a failed reply");
    }
    if (!payload.isReasoning && typeof payload.text === "string" && payload.text.trim()) {
      parts.push(payload.text);
    }
  }
  if (!parts.length) {
    throw new Error("OpenClaw returned no completed text reply");
  }
  return parts.join("\n\n");
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = record(content[0]);
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

async function readTranscript(instance: NativeTrainingInstance, path: string): Promise<string | null | undefined> {
  try {
    const text = await instance.readFile(path);
    return text === null || text.length <= MAX_TRANSCRIPT_CHARS ? text : undefined;
  } catch {
    // An unreadable baseline cannot establish a fresh suffix.
    return undefined;
  }
}

function collectToolRequests(message: NativeRecord, requests: Map<string, string | null>): void {
  if (!Array.isArray(message.content) || message.stopReason === "aborted" || message.stopReason === "error") {
    return;
  }
  for (const value of message.content) {
    const block = record(value);
    if (block?.type === "toolCall" && nativeId(block.id) && nativeId(block.name)) {
      requests.set(block.id, requests.has(block.id) ? null : block.name);
    }
  }
}

function turnObservations(
  before: string | null | undefined,
  after: string | null | undefined,
  turn: NativeTrainingTurn
): Observation[] {
  if (before === undefined || !after || (before !== null && !before.endsWith("\n")) ||
      !after.startsWith(before ?? "")) return [];

  // Parse only whole lines. A bounded or partially written final line supplies no evidence.
  const lines = after.split("\n");
  lines.pop();
  const header = parseRecord(lines[0] ?? "");
  if (header?.type !== "session" || header.id !== turn.sessionId) return [];
  const firstNew = before === null ? 1 : before.split("\n").length - 1;
  const seen = new Set<string>();
  for (const line of lines.slice(1, firstNew)) {
    const entry = parseRecord(line);
    if (!entry || !nativeId(entry.id) || seen.has(entry.id)) return [];
    seen.add(entry.id);
  }

  const observations: Observation[] = [];
  const requests = new Map<string, string | null>();
  let userSeen = false;
  let previous: string | null = null;
  const source = `openclaw:session:${turn.sessionId}`;
  for (let seq = firstNew; seq < lines.length; seq++) {
    const entry = parseRecord(lines[seq] ?? "");
    if (!entry || !nativeId(entry.id) || seen.has(entry.id)) break;
    const parent = entry.parentId;
    if (parent !== previous && (seq !== firstNew || !nativeId(parent) || !seen.has(parent))) break;
    if (seq === firstNew && seen.size > 0 && parent === null) break;
    seen.add(entry.id);
    previous = entry.id;
    if (entry.type !== "message") continue;

    const message = record(entry.message);
    if (!userSeen) {
      if (message?.role !== "user" || messageText(message.content) !== turn.text) break;
      userSeen = true;
      continue;
    }
    if (!message || message.role === "user") break;
    if (message.role === "assistant") {
      collectToolRequests(message, requests);
      continue;
    }
    if (message.role !== "toolResult" || !nativeId(message.toolCallId) ||
        !nativeId(message.toolName) || requests.get(message.toolCallId) !== message.toolName) continue;
    requests.set(message.toolCallId, null);
    if (record(message.details)?.openclawSyntheticMissingToolResult === true ||
        messageText(message.content) === SYNTHETIC_TOOL_RESULT || typeof message.isError !== "boolean" ||
        typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) continue;

    // A toolResult proves an outcome. toolCall blocks only correlate it to the turn.
    // Tool payloads and details can carry secrets or operator diagnostics.
    observations.push({
      id: `${source}:${entry.id}`,
      source,
      seq,
      timestamp: entry.timestamp,
      trialId: turn.trialId,
      wakeId: turn.wakeId,
      type: "tool.complete",
      callId: `${turn.wakeId}:${message.toolCallId}`,
      tool: message.toolName,
      success: !message.isError
    });
  }
  return observations;
}

export const openclawTrainingDriver: NativeTrainingDriver = {
  async run(instance, turn) {
    if (!UUID.test(turn.sessionId)) throw new Error("Invalid OpenClaw training session identity");
    const sessionFile = posix.join(instance.homePath, ".openclaw", "agents", "main", "sessions", `${turn.sessionId}.jsonl`);
    assertActive(turn.signal);
    const before = await readTranscript(instance, sessionFile);
    assertActive(turn.signal);
    let stdout: string;
    try {
      stdout = await instance.exec([
        "node", `${RUNTIME_INSTALL_ROOT}/openclaw/openclaw.mjs`,
        "agent", "--local", "--json", "--agent", "main",
        "--session-id", turn.sessionId, "--timeout", String(Math.ceil(turn.timeoutMs / 1000)),
        `--message=${turn.text}`
      ], {
        env: {
          OPENCLAW_CONFIG_PATH: instance.configPath,
          OPENCLAW_HOME: instance.homePath
        },
        signal: turn.signal,
        timeoutMs: turn.timeoutMs
      });
    } catch {
      assertActive(turn.signal);
      throw new Error("OpenClaw agent command failed");
    }
    assertActive(turn.signal);
    const text = terminalText(stdout, turn.sessionId);
    const after = await readTranscript(instance, sessionFile);
    assertActive(turn.signal);
    const observations = turnObservations(before, after, turn);
    return {
      text,
      observations,
      toolCoverage: { channel: "tools", completeness: "partial", ordering: observations.length ? "source" : "none" }
    };
  }
};
