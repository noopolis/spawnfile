import { maskSecrets } from "../../../../shared/index.js";
import type { TrialDocker, TrialWake } from "../../../../compiler/training/trial/index.js";

export type NativeToolEvent = NonNullable<TrialWake["nativeToolEvents"]>[number];

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 8192;
const MAX_EVENTS = 256;
export const CODEX_THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
export const nativeTimestamp = (value: unknown): value is string =>
  typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));

export const nativeIdentifier = (value: unknown, secrets: readonly string[]): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/u.test(value) && maskSecrets(value, secrets) === value;

// Runs inside the organization. Enumerate the dated sessions tree without opening any unrelated file.
const READ_ROLLOUT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [root, thread, byteLimit] = process.argv.slice(1);
const limit = Number(byteLimit);
const layout = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
const filename = new RegExp("^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-" + thread + "\\.jsonl$");
let candidate;
let entries = 0;
function visit(directory, depth) {
  if (fs.realpathSync(directory) !== directory) throw Error();
  const dir = fs.opendirSync(directory);
  try {
    for (let entry; (entry = dir.readSync()) !== null;) {
      if (++entries > 4096) throw Error();
      const file = path.join(directory, entry.name);
      if (depth < layout.length) {
        if (entry.isDirectory() && layout[depth].test(entry.name)) visit(file, depth + 1);
      } else if (filename.test(entry.name)) {
        if (candidate || !entry.isFile()) throw Error();
        candidate = file;
      }
    }
  } finally { dir.closeSync(); }
}
try {
  visit(root, 0);
  if (candidate && fs.realpathSync(candidate) === candidate) {
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size <= 0n || before.size > BigInt(limit)) throw Error();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let used = 0;
      while (used < bytes.length) {
        const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
        if (!count) break;
        used += count;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (BigInt(used) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw Error();
      process.stdout.write(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
    } finally { fs.closeSync(fd); }
  }
} catch { process.exitCode = 1; }
`;

function execResult(payload: Record<string, unknown>): Pick<NativeToolEvent, "result" | "success"> {
  const code = payload.exit_code;
  const status = payload.status;
  const exitCode = typeof code === "number" && Number.isSafeInteger(code) ? code : undefined;
  const known = status === "completed" || status === "failed" || status === "declined";
  const success = status === "failed" ? false
    : (status === "completed" || status === undefined) && exitCode !== undefined ? exitCode === 0 : undefined;
  return {
    ...(exitCode === undefined && !known ? {} : {
      result: { ...(exitCode === undefined ? {} : { exitCode }), ...(known ? { status } : {}) },
    }),
    ...(success === undefined ? {} : { success }),
  };
}

function mcpResult(value: unknown): Pick<NativeToolEvent, "success"> {
  const envelope = record(value);
  if (!envelope) return {};
  if (Object.hasOwn(envelope, "Err") && !Object.hasOwn(envelope, "Ok") && typeof envelope.Err === "string") return { success: false };
  const response = Object.hasOwn(envelope, "Err") ? undefined : record(envelope.Ok);
  return typeof response?.isError === "boolean" ? { success: !response.isError } : {};
}

interface RolloutIdentity {
  thread: string;
  since: number;
  recordedAt: number;
  secrets: readonly string[];
}

function parseRollout(text: string, identity: RolloutIdentity): NativeToolEvent[] {
  if (!text.endsWith("\n") || Buffer.byteLength(text) > MAX_BYTES) return [];
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_ROWS) return [];
  const { thread, since, recordedAt, secrets } = identity;
  const inWindow = (value: unknown): value is string => nativeTimestamp(value) && Date.parse(value) >= since && Date.parse(value) <= recordedAt;
  const source = `daimon:codex:${thread}`;
  const events: NativeToolEvent[] = [];
  const calls = new Map<string, { tool: string; server: string | undefined; dispatch?: string; ended?: boolean }>();
  let priorSeq = -1;
  let nativeOrdinal: boolean | undefined;
  let turnId: string | undefined;
  for (const [index, line] of lines.entries()) {
    let row: Record<string, unknown> | undefined;
    try { row = record(JSON.parse(line)); } catch { return []; }
    const payload = record(row?.payload);
    if (!row || !payload || typeof row.type !== "string" || !inWindow(row.timestamp)) return [];
    // Newer rollouts record ordinals; older rollouts preserve physical row order.
    nativeOrdinal ??= row.ordinal !== undefined;
    const seq = nativeOrdinal ? row.ordinal : index;
    if (nativeOrdinal !== (row.ordinal !== undefined) || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= priorSeq) return [];
    priorSeq = seq;
    if (index === 0 && row.type !== "session_meta") return [];
    if (row.type === "session_meta" && (index !== 0 || payload.id !== thread
      || (payload.timestamp !== undefined && !inWindow(payload.timestamp)))) return [];
    if ([payload.thread_id, payload.session_id].some(value => value !== undefined && value !== thread)) return [];
    if (payload.turn_id !== undefined) {
      if (typeof payload.turn_id !== "string" || !payload.turn_id || (turnId !== undefined && turnId !== payload.turn_id)) return [];
      turnId = payload.turn_id;
    }
    if (row.type !== "event_msg") continue;
    if (typeof payload.type !== "string") return [];
    const exec = payload.type === "exec_command_begin" || payload.type === "exec_command_end";
    const mcp = payload.type === "mcp_tool_call_begin" || payload.type === "mcp_tool_call_end";
    if (!exec && !mcp) continue;
    if (!nativeIdentifier(payload.call_id, secrets)) return [];
    const invocation = mcp ? record(payload.invocation) : undefined;
    const tool = exec ? "exec_command" : invocation?.tool;
    const server = invocation?.server;
    if (!nativeIdentifier(tool, secrets) || (mcp && server === undefined)) return [];
    if (server !== undefined && !nativeIdentifier(server, secrets)) return [];
    const callId = `${source}:${payload.call_id}`;
    const id = `${source}:${seq}`;
    const call = calls.get(callId) ?? { tool, server };
    const dispatch = payload.type.endsWith("_begin");
    if (call.ended || (dispatch && call.dispatch) || tool !== call.tool || server !== call.server) return [];
    // A refusal can produce an end frame without the command having run.
    if (!(exec && !dispatch && payload.status === "declined")) {
      events.push({ id, source, seq, timestamp: row.timestamp, callId, tool,
        ...(server === undefined ? {} : { native: { server } }),
        ...(dispatch ? { type: "tool.dispatch" } : {
          type: "tool.complete", ...(exec ? execResult(payload) : mcpResult(payload.result)),
          ...(call.dispatch === undefined ? {} : { causalParents: [call.dispatch] }),
        }),
      });
    }
    if (events.length > MAX_EVENTS) return [];
    if (dispatch) call.dispatch = id; else call.ended = true;
    calls.set(callId, call);
  }
  return events;
}

export async function readCodexToolEvidence(docker: TrialDocker, container: string, sessionsPath: string, identity: RolloutIdentity): Promise<NativeToolEvent[]> {
  if (!CODEX_THREAD.test(identity.thread)) return [];
  const text = await docker(["exec", container, "node", "-e", READ_ROLLOUT, sessionsPath, identity.thread, String(MAX_BYTES)],
    { timeoutMs: 5_000, preserveWhitespace: true }).catch(() => "");
  return parseRollout(text, identity);
}
