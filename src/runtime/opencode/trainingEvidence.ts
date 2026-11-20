import { isDeepStrictEqual } from "node:util";

import { maskSecrets } from "../../shared/index.js";
import type { NativeTrainingTurn } from "../nativeTraining.js";
import type { Observation, Usage } from "../trainingTypes.js";

type RecordObject = Record<string, unknown>;

const eventTypes = new Map([
  ["step_start", "step-start"],
  ["step_finish", "step-finish"],
  ["tool_use", "tool"],
  ["text", "text"],
  ["reasoning", "reasoning"]
]);

const persistedEventTypes = new Set([...eventTypes.values()].filter(type => type !== "reasoning"));

const sessionIdFormat = /^ses_[a-zA-Z0-9]+$/u;
const messageIdFormat = /^msg_[a-zA-Z0-9]+$/u;
const partIdFormat = /^prt_[a-zA-Z0-9]+$/u;
const toolNameFormat = /^[a-zA-Z0-9_.:-]{1,128}$/u;

function object(value: unknown): RecordObject | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as RecordObject;
}

function parse(value: string): RecordObject | undefined {
  try { return object(JSON.parse(value)); }
  catch { return undefined; }
}

function fail(): never {
  throw new Error("OpenCode did not produce a verified reply for this turn");
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is number {
  return count(value) && value > 0 && value <= 8_640_000_000_000_000;
}

interface Event {
  timestamp: number;
  part: RecordObject;
}

export function readOpenCodeEvents(stdout: string, expectedSession: string | undefined) {
  let session = expectedSession;
  const events: Event[] = [];
  const ids = new Set<string>();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const row = parse(line);
    if (row?.type === "error") throw new Error("OpenCode reported a native error");
    const part = object(row?.part);
    if (typeof row?.sessionID !== "string" || !sessionIdFormat.test(row.sessionID) ||
        (session !== undefined && row.sessionID !== session) || !part || part.sessionID !== row.sessionID ||
        typeof row.type !== "string" || eventTypes.get(row.type) !== part.type ||
        typeof part.id !== "string" || !partIdFormat.test(part.id) || ids.has(part.id) ||
        typeof part.messageID !== "string" || !messageIdFormat.test(part.messageID) ||
        !timestamp(row.timestamp) || row.timestamp < (events.at(-1)?.timestamp ?? 0)) fail();
    session = row.sessionID;
    ids.add(part.id);
    events.push({ timestamp: row.timestamp, part });
  }
  return { session, events };
}

interface ExpectedTurn {
  session: string | undefined;
  title: string;
  workspace: string;
  previousUsers: readonly string[];
  prompt: string;
}

function nativeParts(parts: unknown[]): RecordObject[] {
  return parts.map(value => object(value) ?? fail());
}

function currentParts(transcript: string, expected: ExpectedTurn) {
  const stored = parse(transcript);
  const session = object(stored?.info);
  const sessionId = session?.id;
  if (!session || typeof sessionId !== "string" || !sessionIdFormat.test(sessionId) ||
      (expected.session !== undefined && sessionId !== expected.session) || session.title !== expected.title ||
      session.directory !== expected.workspace || session.parentID !== undefined ||
      !Array.isArray(stored?.messages)) fail();

  const users: string[] = [];
  const events: Event[] = [];
  const partIds = new Set<string>();
  const messagesSeen = new Set<string>();
  let userTime = 0;
  let finish: unknown;
  for (const entry of stored.messages as unknown[]) {
    const message = object(entry);
    const info = object(message?.info);
    const id = info?.id;
    if (typeof id !== "string" || !messageIdFormat.test(id) || messagesSeen.has(id) ||
        info?.sessionID !== sessionId || !Array.isArray(message?.parts)) fail();
    messagesSeen.add(id);

    if (info.role === "user") {
      users.push(id);
      const n = users.length;
      if (n <= expected.previousUsers.length) {
        if (expected.previousUsers[n - 1] !== id) fail();
        continue;
      }
      if (n !== expected.previousUsers.length + 1) fail();
      const created = object(info.time)?.created;
      const [input, ...extra] = nativeParts(message.parts);
      if (!timestamp(created) || extra.length || input?.type !== "text" || input.text !== expected.prompt ||
          input.synthetic === true || input.ignored === true ||
          input.sessionID !== sessionId || input.messageID !== id) fail();
      userTime = created;
      continue;
    }
    if (!userTime) continue;
    const completed = object(info.time)?.completed;
    if (info.role !== "assistant" || info.parentID !== users.at(-1) || info.error !== undefined ||
        info.summary === true || !timestamp(completed) || completed < userTime) fail();
    finish = info.finish;
    for (const part of nativeParts(message.parts)) {
      if (part.sessionID !== sessionId || part.messageID !== id || typeof part.id !== "string" ||
          !partIdFormat.test(part.id) || partIds.has(part.id)) fail();
      partIds.add(part.id);
      if (typeof part.type === "string" && persistedEventTypes.has(part.type)) events.push({ part, timestamp: completed });
    }
  }
  if (!userTime || finish !== "stop") fail();
  return { session: sessionId, users, events, userTime };
}

function measuredUsage(finishes: RecordObject[]): Usage | null {
  const sum = { input: 0, output: 0, reasoning: 0, read: 0, write: 0 };
  for (const finish of finishes) {
    const tokens = object(finish.tokens);
    const cache = object(tokens?.cache);
    const { input, output, reasoning, total } = tokens ?? {};
    const { read, write } = cache ?? {};
    // OpenCode fills missing buckets with zero. total is left absent when
    // unavailable. Check the decomposition before treating it as measured.
    if (!count(total) || total === 0 || !count(input) || !count(output) ||
        !count(reasoning) || !count(read) || !count(write) ||
        total !== input + output + reasoning + read + write) return null;
    sum.input += input + read + write;
    sum.output += output + reasoning;
    sum.reasoning += reasoning;
    sum.read += read;
    sum.write += write;
  }
  if (!Object.values(sum).every(count)) return null;
  return {
    inputTokens: sum.input,
    cachedInputTokens: sum.read || null,
    cacheWriteInputTokens: sum.write || null,
    outputTokens: sum.output,
    reasoningTokens: sum.reasoning || null,
    source: "opencode:step-finish"
  };
}

function toolObservation(
  event: Event, turn: NativeTrainingTurn, source: string, seq: number, userTime: number
): Observation | undefined {
  const { part } = event;
  const state = object(part.state);
  const time = object(state?.time);
  const name = part.tool;
  if (!state || !timestamp(time?.start) || !timestamp(time.end) ||
      time.start < userTime || time.end < time.start || time.end > event.timestamp ||
      (state.status !== "completed" && state.status !== "error") ||
      typeof name !== "string" || !toolNameFormat.test(name) || maskSecrets(name) !== name ||
      typeof part.callID !== "string" || !part.callID || object(part.metadata)?.providerExecuted === true) return;
  const metadata = object(state.metadata);
  const success = state.status === "completed" && name !== "invalid" &&
    (name !== "bash" || (metadata?.exit === 0 && metadata.timeout !== true));
  const id = `${source}:${part.id}`;
  return {
    id, source, seq, type: "tool.complete", timestamp: new Date(time.end).toISOString(),
    trialId: turn.trialId, wakeId: turn.wakeId, callId: id, tool: name, success
  };
}

export function bindOpenCodeReply(
  events: Event[], transcript: string, expected: ExpectedTurn, turn: NativeTrainingTurn, previousSequence: number
) {
  const durable = currentParts(transcript, expected);
  const { users, userTime } = durable;
  // In attach mode the pinned CLI can finish before the last SSE delivery, including
  // before the first one. Verify every delivered part against the durable turn in order.
  let cursor = 0;
  for (const event of events) {
    if (event.part.type === "reasoning") continue;
    while (cursor < durable.events.length && durable.events[cursor]!.part.id !== event.part.id) cursor++;
    const match = durable.events[cursor++];
    if (!match || !isDeepStrictEqual(match.part, event.part) || event.timestamp < userTime) fail();
  }

  const source = `opencode:run:${turn.sessionId}`;
  const observations: Observation[] = [];
  const finishes: RecordObject[] = [];
  let text: string[] = [];
  let openStep: unknown;
  for (const event of durable.events) {
    const part = event.part;
    if (part.type === "step-start") {
      if (openStep || finishes.at(-1)?.reason === "stop") fail();
      openStep = part.messageID;
      text = [];
      continue;
    }
    if (!openStep || part.messageID !== openStep) fail();
    if (part.type === "step-finish") {
      if (part.reason !== "stop" && part.reason !== "tool-calls") fail();
      finishes.push(part);
      openStep = undefined;
    } else if (part.type === "text") {
      const time = object(part.time);
      if (typeof part.text !== "string" || !timestamp(time?.start) || !timestamp(time.end) ||
          time.start < userTime || time.end < time.start || time.end > event.timestamp) fail();
      if (part.synthetic !== true && part.ignored !== true) text.push(part.text);
    } else {
      const observation = toolObservation(event, turn, source, previousSequence + observations.length + 1, userTime);
      if (observation) observations.push(observation);
    }
  }
  const reply = text.join("\n");
  if (openStep || finishes.at(-1)?.reason !== "stop" || !reply.trim()) fail();
  return { session: durable.session, text: maskSecrets(reply), observations, users, usage: measuredUsage(finishes) };
}
