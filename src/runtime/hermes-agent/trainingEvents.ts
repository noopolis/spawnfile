import { maskSecrets } from "../../shared/index.js";
import type { NativeTrainingTurn } from "../nativeTraining.js";
import type { Observation, Usage } from "../trainingTypes.js";

type Frame = Record<string, unknown>;
const nativeSession = /^local-[a-f0-9]{64}$/u;
const nativeTool = /^[a-zA-Z0-9_-]{1,128}$/u;
const nativeCallId = /^[a-zA-Z0-9_.:-]{1,256}$/u;

function asFrame(value: unknown): Frame | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Frame : undefined;
}

function parseFrame(line: string): Frame | undefined {
  try {
    return asFrame(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 8.64e15) return undefined;
  return new Date(value).toISOString();
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export interface HermesTokenTotals {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyHermesTotals: HermesTokenTotals = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };

function parseTotals(value: unknown): HermesTokenTotals | null {
  const tokens = asFrame(value);
  const input = count(tokens?.input);
  const output = count(tokens?.output);
  const total = count(tokens?.total);
  const cacheRead = count(tokens?.cache_read);
  const cacheWrite = count(tokens?.cache_write);
  // Hermes emits zero for a missing usage receipt.
  if (input === null || output === null || total === null || total <= 0 ||
      cacheRead === null || cacheWrite === null || total < input + output + cacheRead + cacheWrite) return null;
  return { input, output, total, cacheRead, cacheWrite };
}

export function hermesTurnUsage(before: HermesTokenTotals | null, after: HermesTokenTotals | null): Usage | null {
  if (!before || !after) return null;
  const input = after.input - before.input;
  const output = after.output - before.output;
  const cacheRead = after.cacheRead - before.cacheRead;
  const cacheWrite = after.cacheWrite - before.cacheWrite;
  const total = after.total - before.total;
  if (total <= 0 || Math.min(input, output, cacheRead, cacheWrite) < 0 ||
      total < input + output + cacheRead + cacheWrite) return null;
  return {
    inputTokens: input + cacheRead + cacheWrite,
    outputTokens: output,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    reasoningTokens: null,
    source: "hermes-agent:stream-json"
  };
}

function readTools(frames: readonly (Frame | undefined)[], turn: NativeTrainingTurn,
  startedAt: number, endedAt: number, replayGap: boolean) {
  const source = `hermes-agent:stream-json:${turn.sessionId}`;
  const attempts = new Map<string, Observation[]>();
  const ambiguous = new Set<string>();
  let partial = replayGap;
  let sawText = false;
  for (const [index, row] of frames.entries()) {
    if (!row || typeof row.timestamp !== "number" || row.timestamp < startedAt || row.timestamp > endedAt) {
      partial = true;
      continue;
    }
    if (row.type === "text" && typeof row.text === "string" && timestamp(row.timestamp)) {
      sawText = true;
      continue;
    }
    if (row?.type !== "tool_use" && row?.type !== "tool_result") {
      partial = true;
      continue;
    }
    const { name: tool, tool_call_id: nativeId } = row;
    const time = timestamp(row.timestamp);
    if (typeof nativeId !== "string" || !nativeCallId.test(nativeId) || typeof tool !== "string" ||
        !nativeTool.test(tool) || tool === "unknown" || !time || maskSecrets(tool) !== tool || maskSecrets(nativeId) !== nativeId) {
      partial = true;
      continue;
    }

    // Providers may reuse their call IDs on a later turn. The wake scopes identity.
    const callId = `${source}:${turn.wakeId}:${nativeId}`;
    const seq = index + 1;
    const common = { id: `${source}:${turn.wakeId}:${seq}`, source, seq, timestamp: time,
      trialId: turn.trialId, wakeId: turn.wakeId, tool, callId };
    const previous = attempts.get(nativeId);
    if (row.type === "tool_use" && !previous) {
      if (row.input !== undefined && !asFrame(row.input)) {
        partial = true;
        continue;
      }
      attempts.set(nativeId, [{ ...common, type: "tool.dispatch" }]);
    } else if (row.type === "tool_result" && previous?.length === 1 && previous[0]?.tool === tool &&
        typeof row.output === "string" && typeof row.is_error === "boolean") {
      previous.push({ ...common, type: "tool.complete", success: !row.is_error });
    } else {
      partial = true;
      ambiguous.add(nativeId);
    }
  }
  const observations = [...attempts]
    .filter(([id]) => !ambiguous.has(id))
    .flatMap(([, events]) => {
      if (events.length === 1) partial = true;
      return events;
    })
    .sort((left, right) => left.seq - right.seq);
  return { observations, partial: partial || !sawText };
}

export function readHermesTurn(stdout: string, expectedSession: string | undefined,
  previousEnd: number | undefined, turn: NativeTrainingTurn) {
  if (!stdout.endsWith("\n")) throw new Error("Hermes Agent returned a truncated turn stream");
  const [init, ...rest] = stdout.slice(0, -1).split("\n").map(parseFrame);
  const terminal = rest.pop();
  const startedAt = count(init?.timestamp);
  const endedAt = count(terminal?.timestamp);
  if (init?.type !== "system" || init.subtype !== "init" || startedAt === null || !timestamp(startedAt) ||
      terminal?.type !== "result" || endedAt === null || !timestamp(endedAt) || endedAt < startedAt ||
      rest.some(row => row?.type === "result" || row?.type === "system")) {
    throw new Error("Hermes Agent returned invalid turn framing");
  }

  const session = terminal.session_id;
  if (typeof session !== "string" || !nativeSession.test(session) ||
      (expectedSession && session !== expectedSession) ||
      (init.session_id !== "" && init.session_id !== expectedSession)) {
    throw new Error("Hermes Agent returned a different native session");
  }
  if (terminal.exit_code !== 0 || terminal.error !== undefined ||
      typeof terminal.text !== "string" || !terminal.text.trim()) {
    throw new Error("Hermes Agent did not complete the native turn");
  }
  if (previousEnd !== undefined && startedAt <= previousEnd) {
    throw new Error("Hermes Agent returned stale turn evidence");
  }

  const { observations, partial } = readTools(rest, turn, startedAt, endedAt, terminal.replay_gap === true);
  return {
    session,
    endedAt,
    observations,
    text: maskSecrets(terminal.text),
    totals: parseTotals(terminal.tokens),
    toolCoverage: {
      channel: "tools" as const,
      completeness: partial ? observations.length ? "partial" as const : "absent" as const : "complete" as const,
      ordering: observations.length ? "source" as const : "none" as const
    }
  };
}
