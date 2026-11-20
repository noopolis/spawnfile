import { posix } from "node:path";
import { maskSecrets } from "../../shared/index.js";
import type { Observation } from "../trainingTypes.js";
import type { NativeTrainingDriver, NativeTrainingTurn } from "../nativeTraining.js";

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const toolName = /^[a-zA-Z0-9_.:-]{1,128}$/u;
const timestampFormat = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u;
const turnStart = "agent.turn.start";
const turnEnd = "agent.turn.end";
const toolStart = "agent.tool.exec_start";
const toolEnd = "agent.tool.exec_end";
const fallbackReplies = new Set([
  "The model returned an empty response. This may indicate a provider error or token limit.",
  "I've reached \`max_tool_iterations\` without a final response. Increase \`max_tool_iterations\` in config.json if this task needs more tool steps.",
  "Requested output delivered via tool attachment."
]);

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Raw native records and parse errors stay in the trial.
  }
}

function completedLines(bytes: string): string[] {
  // The native JSONL writers end every record with a newline.
  return bytes.split("\n").slice(0, -1);
}

function isNativeTimestamp(value: unknown): value is string {
  return typeof value === "string" && timestampFormat.test(value) && !Number.isNaN(Date.parse(value));
}

function sessionReply(
  before: string | null, after: string | null, meta: string | null, sessionKey: string, prompt: string, stdout: string
): string {
  const failure = "PicoClaw did not produce a completed reply for this turn";
  if (meta === null || parseRecord(meta)?.key !== sessionKey || !after?.endsWith("\n")) throw new Error(failure);

  const earlier = completedLines(before ?? "");
  const current = completedLines(after);
  // Context compression can retain a suffix of the history. Its rows are still
  // earlier evidence, including when a user repeats the same prompt.
  const retainedStart = earlier.indexOf(current[0]!);
  const retained = retainedStart >= 0 ? earlier.slice(retainedStart) : [];
  if (retained.some((line, i) => line !== current[i])) throw new Error(failure);

  const appended = current.slice(retained.length);
  const [input, ...rest] = appended.map(parseRecord);
  const output = rest.at(-1);
  const text = output?.content;
  if (input?.role !== "user" || input.content !== prompt || !isNativeTimestamp(input.created_at) ||
      rest.some(row => !row || row.role === "user") || output?.role !== "assistant" ||
      !isNativeTimestamp(output.created_at) || output.tool_calls !== undefined || typeof text !== "string" || !text.trim() ||
      fallbackReplies.has(text.trim()) || earlier.includes(appended.at(-1)!)) {
    throw new Error(failure);
  }
  // v0.3.1 agent/helpers.go prints "\n%s %s\n" after ProcessDirect returns.
  // Use stdout only to confirm the persisted reply was returned by this process.
  if (!["🦞", ""].some(icon => stdout.endsWith(`\n${icon} ${text}\n`))) throw new Error(failure);
  return text;
}

interface NativeEvent {
  readonly row: Record<string, unknown>;
  readonly kind: string;
  readonly id: string;
  readonly turnId: string;
  readonly time: string;
  readonly seq: number;
}

function toolObservations(
  before: string | null, after: string | null, sessionKey: string, turn: NativeTrainingTurn, reply: string
): Observation[] {
  const prefix = before ?? "";
  if (!after?.startsWith(prefix) || (prefix && !prefix.endsWith("\n"))) return [];

  const events: NativeEvent[] = [];
  const earlier = completedLines(prefix);
  const previousRows = new Set(earlier);
  for (const [index, line] of completedLines(after.slice(prefix.length)).entries()) {
    if (previousRows.has(line)) continue;
    const row = parseRecord(line);
    if (row?.component !== "events" || row.session_key !== sessionKey || row.channel !== "cli" ||
        row.agent_id !== "main" || typeof row.caller !== "string" ||
        !/(?:^|\/)runtime_event_logger\.go:\d+$/u.test(row.caller)) continue;

    const { event_kind: kind, event_id: id, event_time: time, turn_id: turnId } = row;
    if (typeof kind !== "string" || row.message !== `Runtime event: ${kind}` ||
        typeof id !== "string" || !id || typeof turnId !== "string" || !turnId || !isNativeTimestamp(time)) continue;
    events.push({ row, kind, id, turnId, time, seq: earlier.length + index + 1 });
  }

  const starts = events.filter(event => event.kind === turnStart);
  const start = starts[0];
  if (starts.length !== 1 || !start || start.row.user_len !== Buffer.byteLength(turn.text)) return [];
  const bound = events.filter(event => event.turnId === start.turnId);
  if (new Set(bound.map(event => event.id)).size !== bound.length) return [];
  const terminals = bound.filter(event => event.kind === turnEnd);
  const terminal = terminals[0];
  if (!terminal || terminals.length !== 1 || terminal.seq <= start.seq) return [];
  if (terminal.row.status !== "completed") throw new Error("PicoClaw reported an unsuccessful turn");
  if (terminal.row.final_len !== Buffer.byteLength(reply)) return [];

  const observations: Observation[] = [];
  const source = `picoclaw:runtime-events:${turn.sessionId}`;
  let dispatch: { observation: Observation; iteration: unknown } | undefined;
  for (const event of bound) {
    if (event.seq <= start.seq || event.seq >= terminal.seq ||
        (event.kind !== toolStart && event.kind !== toolEnd)) continue;
    const previous = dispatch;
    dispatch = undefined;
    const tool = event.row.tool;
    if (typeof tool !== "string" || !toolName.test(tool) || maskSecrets(tool) !== tool) continue;

    const common = { id: `${source}:${event.seq}`, source, seq: event.seq, timestamp: event.time,
      trialId: turn.trialId, wakeId: turn.wakeId, tool };
    if (event.kind === toolStart) {
      const observation: Observation = { ...common, type: "tool.dispatch", callId: common.id };
      dispatch = { observation, iteration: event.row.iteration };
      observations.push(observation);
    } else if (previous?.observation.tool === tool && previous.iteration === event.row.iteration &&
        event.row.async === false && typeof event.row.is_error === "boolean") {
      observations.push({ ...common, type: "tool.complete", callId: previous.observation.id, success: !event.row.is_error });
    }
  }
  return observations;
}

export const picoclawTrainingDriver: NativeTrainingDriver = {
  async run(instance, turn) {
    if (!uuid.test(turn.sessionId) || !turn.text.trim()) throw new Error("Invalid PicoClaw training turn");

    // Explicit agent-scoped sessions survive CLI routing. A bare UUID falls
    // through to the route's session allocator in v0.3.1.
    const sessionKey = `agent:main:cli:direct:${turn.sessionId}`;
    const sessionPath = posix.join(instance.workspacePath, "sessions", sessionKey.replaceAll(":", "_"));
    const sessionLog = `${sessionPath}.jsonl`;
    const sessionMeta = `${sessionPath}.meta.json`;
    const eventLog = posix.join(instance.homePath, ".spawnfile-training", `${turn.sessionId}.jsonl`);
    const readEvents = () => instance.readFile(eventLog).catch(() => undefined);
    const readSession = (file: string) => instance.readFile(file).catch(() => {
      throw new Error("PicoClaw session records are unreadable");
    });

    const [before, eventsBefore] = await Promise.all([readSession(sessionLog), readEvents()]);
    if (turn.signal?.aborted) throw new Error("PicoClaw training turn was cancelled");
    const stdout = await instance.exec(["/usr/local/bin/picoclaw", "agent", "--session", sessionKey, `--message=${turn.text}`], {
      env: {
        HOME: instance.homePath,
        CODEX_HOME: posix.join(instance.homePath, ".codex"),
        PICOCLAW_HOME: instance.homePath,
        PICOCLAW_CONFIG: instance.configPath,
        PICOCLAW_LOG_FILE: eventLog,
        PICOCLAW_LOG_LEVEL: "info",
        PICOCLAW_EVENTS_LOGGING_ENABLED: "true",
        PICOCLAW_EVENTS_LOGGING_INCLUDE: "agent.turn.*,agent.tool.*",
        PICOCLAW_EVENTS_LOGGING_INCLUDE_PAYLOAD: "false"
      },
      signal: turn.signal,
      timeoutMs: turn.timeoutMs
    }).catch(() => {
      throw new Error("PicoClaw native command failed");
    });

    const [after, meta, eventsAfter] = await Promise.all([
      readSession(sessionLog), readSession(sessionMeta), readEvents()
    ]);
    if (turn.signal?.aborted) throw new Error("PicoClaw training turn was cancelled");
    const text = sessionReply(before, after, meta, sessionKey, turn.text, stdout);
    const observations = eventsBefore !== undefined && eventsAfter !== undefined
      ? toolObservations(eventsBefore, eventsAfter, sessionKey, turn, text) : [];
    // The log subscriber can drop events, and arguments, results and usage
    // are withheld. Session tool messages also represent skipped requests.
    return { text: maskSecrets(text), observations, toolCoverage: {
      channel: "tools", completeness: "partial", ordering: observations.length ? "source" : "none"
    } };
  }
};
