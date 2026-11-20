import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TrialDocker } from "../../../../compiler/training/trial/index.js";
import { cachedTrial, openTrialCacheStore } from "../../../../compiler/training/trial/cache/index.js";
import { createEvaluationRegistry, evaluateNode, evaluationContext, happensBefore, snapshot, type Observation } from "../../../../training/index.js";
import { createDaimonBootedAdapter, type BootedTrialLauncher } from "../booted/index.js";
import { createBootedTrial } from "./bootedTrial.js";

const execute = promisify(execFile);
const epoch = Date.parse("2026-09-05T01:31:52.000Z");
const frameTime = (offset: number) => new Date(epoch + offset).toISOString();
const thread = "01a06f31-0000-7000-8000-000000000001";
const otherThread = "01a06f31-0000-7000-8000-000000000002";
const source = `daimon:codex:${thread}`;
const agent = "agent:writer";
const delivery = "first:task";
const datePath = "2026/09/05";
const secret = "keep-this-private";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(await realpath(os.tmpdir()), "spawnfile-native-tools-"));
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

type Row = Record<string, unknown>;
const jsonl = (...rows: Row[]) => rows.map(row => JSON.stringify(row) + "\n").join("");
const request = (patch: Row = {}): Row => ({
  v: "noopolis.daimon.turn-requests.v1", agent, wake: delivery, engine: "codex", at: frameTime(500), thread,
  request: 0, requests: 1, input: 3, cached_input: 0, fresh_input: 3, cache_write: 0, output: 2, total: 5, ...patch,
});
const meta = (id = thread, offset = 1): Row => ({
  type: "session_meta", ordinal: 0, timestamp: frameTime(offset), payload: { id, timestamp: frameTime(offset), base_instructions: secret },
});
const message = (ordinal: number, type: string, payload: Row): Row => ({
  type: "event_msg", ordinal, timestamp: frameTime(ordinal), payload: { type, ...payload },
});
const begin = message(11, "exec_command_begin", { call_id: "cmd", command: ["echo", secret] });
const end = message(18, "exec_command_end", { call_id: "cmd", exit_code: 0, status: "completed", aggregated_output: secret });
const pending = message(20, "exec_command_begin", { call_id: "pending" });
const invoke = { tool: "file_article", server: "newsroom", arguments: { prompt: secret } };
const mcpBegin = message(29, "mcp_tool_call_begin", { call_id: "file", invocation: invoke });
const mcpEnd = message(34, "mcp_tool_call_end", { call_id: "file", invocation: invoke, result: { Ok: { isError: false, content: [secret] } } });
const requested = { type: "response_item", ordinal: 10, timestamp: frameTime(10),
  payload: { type: "function_call", name: "forged", call_id: "pretend" } };
const valid = () => jsonl(meta(), requested, begin, end, pending, mcpBegin, mcpEnd);

const rolloutPath = (date: string, id = thread) => path.join(root, "sessions", date, `rollout-2026-09-05T01-31-52-${id}.jsonl`);
async function writeRollout(content: string, date = datePath, id = thread) {
  const file = rolloutPath(date, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

const executionId = "01a06f31-0000-7000-8000-000000000003";

function world(requests = jsonl(request()), transcript = "", control: { receipt?: Row; activity?: Row } = {}) {
  const reads: string[] = [];
  let boots = 0;
  const docker: TrialDocker = async (args, options) => {
    if (args.at(-1)?.endsWith("/requests.jsonl")) return requests;
    if (args[2] === "sh") return transcript ? `${epoch / 1000 + 1} /unbound.jsonl\n` : "";
    if (args[2] === "head") return transcript;
    if (args[2] !== "node") return "";
    reads.push(args[6]!);
    return (await execute(process.execPath, args.slice(3), { timeout: options?.timeoutMs })).stdout;
  };
  const boot = async () => {
    boots++;
    return createBootedTrial({ agentId: agent, container: "fixture", docker, moment: undefined,
      secrets: [secret], sessionsPath: path.join(root, "sessions"), target: {} as never, teardown: async () => null, workspace: null,
      call: async (_target, method, route) => {
        if (method === "POST") return { status: 202, body: JSON.stringify({ state: "accepted", acceptance_id: "1" }) };
        if (route.startsWith("/v2/wake-receipts/")) return { status: 200, body: JSON.stringify(control.receipt ?? { state: "completed", text: "filed" }) };
        if (route === "/v2/activity" && control.activity) return { status: 200, body: JSON.stringify(control.activity) };
        return { status: 200, body: "{}" };
      },
    });
  };
  return { boot, reads, count: () => boots };
}

async function run(launcher: BootedTrialLauncher, trialId = "first", wakeId = "task", advanceMs = 1_000) {
  const events: Observation[] = [];
  const subject = createDaimonBootedAdapter({ launcher, timeoutMs: 2_000 });
  const handle = await subject.start({ trialId, workspacePath: root, runtimeHomePath: root, instructions: "fixture",
    onObservation: event => { events.push(event); } });
  const pending = handle.run({ id: wakeId, text: "do the work" });
  await vi.advanceTimersByTimeAsync(advanceMs);
  const result = await pending;
  await handle.stop("done");
  return { events, result, tools: events.filter(event => event.type.startsWith("tool.")) };
}

it("emits only native tool lifecycle events and preserves them across a real on-disk cache hit", async () => {
  await writeRollout(valid());
  const fixture = world();
  const launch = (name: string): BootedTrialLauncher => ({ boot: async ({ trialId }) => cachedTrial({
    store: openTrialCacheStore(path.join(root, "cache"), path.join(root, name, "claims.jsonl")),
    base: "fixture", mode: "reuse", trialId, evidenceDirectory: path.join(root, name, "evidence"), boot: fixture.boot,
    discard: async () => undefined,
  }) });
  const fresh = await run(launch("record"));
  expect(fresh.result.coverage).toContainEqual({ channel: "tools", completeness: "partial", ordering: "none" });
  expect(fresh.tools.map(({ type, tool, seq, timestamp, success }) => [type, tool, seq, timestamp, success])).toEqual([
    ["tool.dispatch", "exec_command", 11, frameTime(11), undefined],
    ["tool.complete", "exec_command", 18, frameTime(18), true],
    ["tool.dispatch", "exec_command", 20, frameTime(20), undefined],
    ["tool.dispatch", "file_article", 29, frameTime(29), undefined],
    ["tool.complete", "file_article", 34, frameTime(34), true],
  ]);
  expect(fresh.tools[1]).toMatchObject({ source, id: `${source}:18`, callId: `${source}:cmd`, causalParents: [`${source}:11`],
    result: { status: "completed", exitCode: 0 } });
  expect(fresh.tools[4]).toMatchObject({ native: { server: "newsroom" }, causalParents: [`${source}:29`] });
  expect(JSON.stringify(fresh.events)).not.toContain(secret);
  expect(happensBefore(fresh.tools[0]!, fresh.tools[1]!, fresh.events, fresh.result.coverage)).toBe(true);
  expect(happensBefore(fresh.tools[1]!, fresh.tools[3]!, fresh.events, fresh.result.coverage)).toBeUndefined();

  const reused = await run(launch("replay"), "second", "renamed");
  expect(reused.result.evidence?.reusedFrom).toBe("first");
  expect(reused.result.coverage).toEqual(fresh.result.coverage);
  expect(reused.tools).toEqual(fresh.tools.map(event => ({ ...event, trialId: "second", wakeId: "renamed" })));
  expect(fixture.reads).toEqual([thread]);
  expect(fixture.count()).toBe(1);
});

it.each([
  { mode: "receipt", receipt: { state: "completed", execution_id: executionId }, deliveries: undefined, accepted: true },
  { mode: "single-delivery activity", receipt: { state: "accepted", deferred: true }, deliveries: [delivery], accepted: true },
  { mode: "batched activity", receipt: { state: "completed", execution_id: executionId }, deliveries: [delivery, "other"], accepted: false },
  { mode: "unrelated activity", receipt: { state: "completed" }, deliveries: ["other"], accepted: false },
])("uses only an exact wake-to-execution link from $mode", async ({ receipt, deliveries, accepted }) => {
  await writeRollout(valid());
  const activity = deliveries ? { executions: [{ agent_id: agent, execution_id: executionId, delivery_ids: deliveries }] } : undefined;
  const fixture = world(jsonl(request({ wake: executionId })), "", { receipt, activity });
  const result = await run(fixture, "first", "task", 2_000);
  expect(fixture.reads).toEqual(accepted ? [thread] : []);
  expect(result.tools).toHaveLength(accepted ? 5 : 0);
});

it("records completion-only, failed, and unknown outcomes without inventing dispatch or success", async () => {
  const unknown = message(41, "mcp_tool_call_end", { call_id: "unknown", invocation: invoke, result: { Ok: { content: [secret] } } });
  const failed = message(42, "mcp_tool_call_end", { call_id: "failure", invocation: invoke, result: { Err: secret } });
  const nonzero = message(43, "exec_command_end", { call_id: "nonzero", exit_code: 1, status: "completed" });
  const refused = message(44, "exec_command_end", { call_id: "refused", exit_code: 0, status: "declined" });
  await writeRollout(jsonl(meta(), end, unknown, failed, nonzero, refused));
  const result = await run(world());
  expect(result.tools.map(event => [event.type, event.success, event.causalParents])).toEqual([
    ["tool.complete", true, undefined],
    ["tool.complete", undefined, undefined],
    ["tool.complete", false, undefined],
    ["tool.complete", false, undefined],
  ]);
  expect(JSON.stringify(result.tools)).not.toContain(secret);
});

it.each([
  ["other agent", jsonl(request({ agent: "agent:other" }))],
  ["other wake", jsonl(request({ wake: "first:other" }))],
  ["old wake", jsonl(request({ at: frameTime(-1) }))],
  ["future wake", jsonl(request({ at: frameTime(1_001) }))],
  ["incomplete batch", jsonl(request({ requests: 2 }))],
  ["torn ledger line", JSON.stringify(request())],
  ["invalid thread", jsonl(request({ thread: "*../other" }))],
  ["thread tied to other wake", jsonl(request(), request({ wake: "first:other" }))],
  ["two possible threads", jsonl(request(), request({ thread: otherThread }))],
  ["two possible engines", jsonl(request(), request({ engine: "agy", thread: undefined }))],
])("skips rollout IO for %s", async (_case, ledger) => {
  await writeRollout(valid());
  const fixture = world(ledger, valid());
  const result = await run(fixture);
  expect(fixture.reads).toEqual([]);
  expect(result.tools).toEqual([]);
  expect(result.events.some(event => event.type === "diagnostic")).toBe(true);
  expect(result.result.coverage).toContainEqual({ channel: "tools", completeness: "absent", ordering: "none" });
});

it.each([
  ["stale session", () => jsonl(meta(thread, -1), begin, end)],
  ["wrong metadata ID", () => jsonl(meta(otherThread), begin, end)],
  ["later foreign session ID", () => jsonl(meta(), begin, { ...end, payload: { type: "exec_command_end", call_id: "cmd", session_id: otherThread } })],
  ["second session", () => jsonl(meta(), begin, end, meta())],
  ["two turn IDs", () => jsonl(meta(), message(11, "exec_command_begin", { call_id: "cmd", turn_id: "first" }),
    message(18, "exec_command_end", { call_id: "cmd", turn_id: "second" }))],
  ["torn final row", () => valid().slice(0, -1)],
  ["malformed JSON anywhere", () => valid() + "{bad json}\n"],
  ["missing lifecycle identity", () => jsonl(meta(), begin, message(15, "exec_command_end", {}))],
  ["duplicate ordinal", () => jsonl(meta(), begin, begin)],
  ["after ledger append", () => jsonl(meta(), begin, message(501, "exec_command_end", { call_id: "cmd" }))],
  ["oversize rollout", () => jsonl(meta(), begin, message(22, "agent_message", { message: "X".repeat(2 * 1024 * 1024) }))],
  ["too many native events", () => jsonl(meta(), ...Array.from({ length: 257 }, (_, index) =>
    message(index + 11, "exec_command_begin", { call_id: `cmd-${index}` })))],
])("discards the rollout for %s", async (_case, content) => {
  await writeRollout(content());
  const fixture = world();
  const result = await run(fixture);
  expect(fixture.reads).toEqual([thread]);
  expect(result.tools).toEqual([]);
  expect(result.result.coverage).toContainEqual({ channel: "tools", completeness: "absent", ordering: "none" });
});

it("refuses ambiguous filenames and only examines a regular file in the exact thread's dated path", async () => {
  await writeRollout(valid(), datePath, otherThread);
  const fixture = world();
  expect((await run(fixture)).tools).toEqual([]);
  await mkdir(path.dirname(rolloutPath(datePath)), { recursive: true });
  await symlink(rolloutPath(datePath, otherThread), rolloutPath(datePath));
  vi.setSystemTime(epoch);
  expect((await run(fixture)).tools).toEqual([]);
  await rm(rolloutPath(datePath));
  await writeRollout(valid());
  await writeRollout(valid(), "2026/09/06");
  vi.setSystemTime(epoch);
  expect((await run(fixture)).tools).toEqual([]);
});

it.each(["grok", "agy"])("keeps %s requests out of tool-called and sequence witnesses", async engine => {
  const ledger = jsonl(request({ engine, thread: undefined, tool_calls: ["validate", "file"] }),
    request({ engine, thread: undefined, at: frameTime(502), wake: "other", tool_calls: ["wrong-wake"] }),
    request({ engine, thread: undefined, at: frameTime(503), tool_calls: Array(33).fill("excess") }),
    request({ engine, thread: undefined, at: frameTime(504), tool_calls: [secret] }));
  const fixture = world(ledger);
  const { tools, result } = await run(fixture);
  expect(fixture.reads).toEqual([]);
  expect(tools).toMatchObject([{ type: "tool.request", seq: 0, timestamp: frameTime(500), args: { tools: ["validate", "file"] } }]);
  expect(result.coverage).toContainEqual({ channel: "tools", completeness: "absent", ordering: "none" });
  const context = evaluationContext({ snapshot: snapshot({ events: tools, coverage: result.coverage }) });
  const registry = createEvaluationRegistry();
  for (const check of [
    { eval: "tool-called", tool: "validate" },
    { eval: "tool-sequence", order: "happens-before", steps: [{ tool: "validate" }, { tool: "file" }] },
  ]) {
    expect(await evaluateNode(check, context, registry)).toMatchObject({ status: "unknown", evidence: [] });
  }
});
