import { describe, expect, it, vi } from "vitest";
import type { NativeTrainingInstance, NativeTrainingTurn } from "../nativeTraining.js";
import { openClawAdapter } from "./adapter.js";
import { openclawTrainingDriver } from "./training.js";

const sessionId = "b864d2f2-e91c-4b9a-882b-0987fb0116a1";
const home = "/compiled/subject/home";
const config = `${home}/.openclaw/openclaw.json`;
const workspace = `${home}/.openclaw/workspace`;
const transcriptPath = `${home}/.openclaw/agents/main/sessions/${sessionId}.jsonl`;
const text = "--literal argument\nRun lookup.";
const timestamp = "2026-06-11T10:00:00.000Z";
const turn: NativeTrainingTurn = { sessionId, trialId: "trial", wakeId: "wake-1", text, timeoutMs: 2_500 };

function nativeReply(meta: Record<string, unknown> = {}, payloads: unknown[] = [{ text: "Done." }]): string {
  return JSON.stringify({
    payloads,
    meta: {
      durationMs: 172,
      aborted: false,
      stopReason: "stop",
      agentMeta: { sessionId, provider: "anthropic", model: "claude-sonnet-4-6" },
      ...meta
    }
  });
}

function jsonl(...entries: object[]): string {
  return entries.map(entry => JSON.stringify(entry) + "\n").join("");
}

function message(id: string, parentId: string | null, fields: object): object {
  return { type: "message", id, parentId, timestamp, message: { timestamp: Date.parse(timestamp), ...fields } };
}

function user(id: string, parentId: string | null, input = text): object {
  return message(id, parentId, { role: "user", content: [{ type: "text", text: input }] });
}

function toolRequest(id: string, parentId: string, name = "lookup"): object {
  return message(id, parentId, {
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call_1", name, arguments: { apiKey: "secret-sentinel" } }]
  });
}

function toolResult(id: string, parentId: string, fields: Record<string, unknown> = {}): object {
  return message(id, parentId, {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "lookup",
    content: [{ type: "text", text: "secret-sentinel" }],
    isError: false,
    ...fields
  });
}

// Session JSONL uses the message entry and toolResult shapes consumed by
// v2026.6.11's session-tool-result-guard.ts and config/sessions/paths.ts.
const header = { type: "session", version: 3, id: sessionId, timestamp, cwd: workspace };
const firstTurn = jsonl(header, user("aa001111", null), toolRequest("aa002222", "aa001111"),
  toolResult("aa003333", "aa002222"));

function instance(before: string | null, after: string | null, stdout = nativeReply()) {
  const exec = vi.fn<NativeTrainingInstance["exec"]>().mockResolvedValue(stdout);
  const readFile = vi.fn<NativeTrainingInstance["readFile"]>()
    .mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  return { configPath: config, homePath: home, workspacePath: workspace, exec, readFile };
}

describe("OpenClaw native training", () => {
  it("runs the compiled native CLI once in the supplied instance and reads its session", async () => {
    expect(openClawAdapter.training?.adapterId).toBe("openclaw");
    const native = instance(null, firstTurn, nativeReply({ replayInvalid: true }));
    const signal = new AbortController().signal;
    const reply = await openclawTrainingDriver.run(native, { ...turn, signal });
    expect(native.exec.mock.calls).toEqual([[
      ["node", "/opt/spawnfile/runtime-installs/openclaw/openclaw.mjs",
        "agent", "--local", "--json", "--agent", "main",
        "--session-id", sessionId, "--timeout", "3", `--message=${text}`],
      {
        env: { OPENCLAW_CONFIG_PATH: config, OPENCLAW_HOME: home },
        signal, timeoutMs: 2_500
      }
    ]]);
    expect(native.readFile.mock.calls).toEqual([[transcriptPath], [transcriptPath]]);
    expect(native.readFile.mock.invocationCallOrder[0]).toBeLessThan(native.exec.mock.invocationCallOrder[0]!);
    expect(native.readFile.mock.invocationCallOrder[1]).toBeGreaterThan(native.exec.mock.invocationCallOrder[0]!);
    expect(reply).toEqual({
      text: "Done.",
      toolCoverage: { channel: "tools", completeness: "partial", ordering: "source" },
      observations: [{
        id: `openclaw:session:${sessionId}:aa003333`,
        source: `openclaw:session:${sessionId}`,
        seq: 3, timestamp, trialId: "trial", wakeId: "wake-1",
        type: "tool.complete", callId: "wake-1:call_1", tool: "lookup", success: true
      }]
    });
  });

  it("continues the same session and scopes repeated prompts and call IDs to the new wake", async () => {
    const updated = firstTurn + jsonl(
      user("bb001111", "aa003333"),
      toolRequest("bb002222", "bb001111"),
      toolResult("bb003333", "bb002222", { isError: true }),
      message("bb004444", "bb003333", { role: "assistant", content: [{ type: "text", text: "Done." }] })
    );
    const native = instance(firstTurn, updated);
    const reply = await openclawTrainingDriver.run(native, { ...turn, wakeId: "wake-2" });
    expect(native.exec.mock.calls[0]?.[0]).toContain(sessionId);
    expect(reply.observations).toEqual([expect.objectContaining({
      id: `openclaw:session:${sessionId}:bb003333`,
      seq: 6, wakeId: "wake-2", callId: "wake-2:call_1", success: false
    })]);
  });

  it.each([
    ["missing transcript", null, null],
    ["foreign header", null, firstTurn.replace(sessionId, "foreign")],
    ["stale completed prompt", firstTurn, firstTurn],
    ["rewritten transcript", firstTurn, firstTurn.replace("aa003333", "bb003333")],
    ["foreign user", null, firstTurn.replace("Run lookup.", "Other prompt.")],
    ["foreign branch", null, firstTurn.replace('"parentId":"aa002222"', '"parentId":"foreign"')],
    ["unpaired result", null, jsonl(header, user("u", null), toolResult("r", "u"))],
    ["model request and tool-like prose", null, jsonl(
      header, user("u", null), toolRequest("a", "u"),
      message("b", "a", { role: "assistant", content: [{ type: "text", text: "lookup succeeded" }] })
    )],
    ["synthetic repair", null, jsonl(
      header, user("u", null), toolRequest("a", "u"),
      toolResult("b", "a", { isError: true, details: { openclawSyntheticMissingToolResult: true } })
    )],
    ["missing native outcome", null, jsonl(
      header, user("u", null), toolRequest("a", "u"), toolResult("b", "a", { isError: undefined })
    )],
    ["truncated result", null, firstTurn.slice(0, -1)],
    ["next turn", null, jsonl(
      header, user("u", null), toolRequest("a", "u"), user("v", "a"), toolResult("b", "v")
    )]
  ] as const)("keeps a terminal reply with partial coverage for %s", async (_name, before, after) => {
    expect(await openclawTrainingDriver.run(instance(before, after), turn)).toEqual({
      text: "Done.", observations: [],
      toolCoverage: { channel: "tools", completeness: "partial", ordering: "none" }
    });
  });

  it("keeps independently bound records before a truncated tail", async () => {
    const reply = await openclawTrainingDriver.run(instance(null, firstTurn + '{"type":"message"'), turn);
    expect(reply.observations).toHaveLength(1);
    expect(reply.toolCoverage.completeness).toBe("partial");
  });

  it("does not use an unreadable transcript baseline to establish freshness", async () => {
    const native = instance(null, firstTurn);
    native.readFile.mockReset().mockRejectedValueOnce(new Error("private diagnostic")).mockResolvedValueOnce(firstTurn);
    const reply = await openclawTrainingDriver.run(native, turn);
    expect(reply.observations).toEqual([]);
    expect(reply.toolCoverage.completeness).toBe("partial");
  });

  it.each([
    JSON.stringify({ status: "accepted", runId: sessionId }),
    nativeReply({ agentMeta: { sessionId: "foreign" } }),
    nativeReply({ aborted: true }),
    nativeReply({ yielded: true }),
    nativeReply({ stopReason: "tool_calls" }),
    nativeReply({ stopReason: "length" }),
    nativeReply({ error: { message: "secret-sentinel" } }),
    nativeReply({}, [{ text: "secret-sentinel", isError: true }]),
    nativeReply({}, [{ text: "private reasoning", isReasoning: true }]),
    "untrusted console output\n" + nativeReply(),
    "Done."
  ])("rejects nonterminal, foreign or unframed stdout", async stdout => {
    const native = instance(null, firstTurn, stdout);
    await expect(openclawTrainingDriver.run(native, turn)).rejects.toThrow(/^OpenClaw returned/);
    expect(native.readFile).toHaveBeenCalledTimes(1);
  });

  it("never passes executor diagnostics into the training reply or error", async () => {
    const native = instance(null, null);
    native.exec.mockRejectedValueOnce(new Error("secret-sentinel"));
    await expect(openclawTrainingDriver.run(native, turn)).rejects.toThrow(/^OpenClaw agent command failed$/);
  });

  it("keeps native cancellation typed and removes its private reason", async () => {
    const native = instance(null, null);
    const controller = new AbortController();
    native.exec.mockImplementationOnce(async () => {
      controller.abort(new Error("secret-sentinel"));
      throw controller.signal.reason;
    });
    await expect(openclawTrainingDriver.run(native, { ...turn, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError", message: "OpenClaw training turn cancelled" });
  });

  it("rejects a non-UUID session before reading state or invoking the harness", async () => {
    const native = instance(null, null);
    await expect(openclawTrainingDriver.run(native, { ...turn, sessionId: "../foreign" })).rejects.toThrow(
      "Invalid OpenClaw training session identity"
    );
    expect(native.exec).not.toHaveBeenCalled();
    expect(native.readFile).not.toHaveBeenCalled();
  });
});
