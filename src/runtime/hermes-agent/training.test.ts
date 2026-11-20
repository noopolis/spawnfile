import { describe, expect, it, vi } from "vitest";

import type { NativeTrainingInstance, NativeTrainingTurn } from "../nativeTraining.js";
import { hermesTrainingDriver } from "./training.js";

const sessionId = `local-${"a".repeat(64)}`;
const time = 1795209266143;
let nextTimestamp = time;
const init = { type: "system", subtype: "init", session_id: "" };
const text = { type: "text", text: "Native answer" };
const started = { type: "tool_use", name: "read_file", tool_call_id: "call_local_file", input: { path: "sentinel.txt" } };
const completed = { type: "tool_result", name: "read_file", tool_call_id: "call_local_file", is_error: false, output: "file sentinel" };
const tokens = { input: 38, output: 22, total: 65, cache_read: 3, cache_write: 2 };
const result = { type: "result", session_id: sessionId, exit_code: 0, text: "Native answer", tokens };
const turn: NativeTrainingTurn = { trialId: "trial", wakeId: "w1", sessionId: "spawnfile-instance", text: "Prompt", timeoutMs: 2500 };

function stream(...frames: Record<string, unknown>[]) {
  return frames.map(frame => JSON.stringify({ timestamp: nextTimestamp++, ...frame })).join("\n") + "\n";
}

function instanceFor(...streams: string[]) {
  const exec = vi.fn<NativeTrainingInstance["exec"]>();
  for (const value of streams) exec.mockResolvedValueOnce(value);
  return {
    configPath: "/data/home/config.yaml", homePath: "/data/home", workspacePath: "/data/work space",
    exec, readFile: vi.fn<NativeTrainingInstance["readFile"]>().mockResolvedValue(null)
  };
}

describe("Hermes Agent training driver", () => {
  it("resumes only the captured native session, correlates reused tool IDs and subtracts cumulative usage", async () => {
    const next = { ...result, tokens: { input: 57, output: 33, total: 95, cache_read: 3, cache_write: 2 } };
    const instance = instanceFor(stream(init, started, completed, text, result),
      stream(init, started, { ...completed, is_error: true }, text, next));
    const first = await hermesTrainingDriver.run(instance, turn);
    const second = await hermesTrainingDriver.run(instance, { ...turn, wakeId: "w2", text: "--next prompt" });

    expect(instance.exec.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["-q=Prompt", "--format", "stream-json", "--in", "/data/work space"]));
    expect(instance.exec.mock.calls[0]?.[0]).not.toContain("--resume");
    expect(instance.exec.mock.calls[1]?.[0].slice(-5)).toEqual(["-q=--next prompt", "--format", "stream-json", "--resume", sessionId]);
    expect(instance.exec.mock.calls[0]?.[1]).toMatchObject({ env: { HERMES_HOME: "/data/home", HOME: "/data/home" }, timeoutMs: 2500 });
    expect(first.observations).toMatchObject([
      { type: "tool.dispatch", tool: "read_file", wakeId: "w1", seq: 1 },
      { type: "tool.complete", success: true, wakeId: "w1", seq: 2 }
    ]);
    expect(first.observations?.[0]?.callId).toBe(first.observations?.[1]?.callId);
    expect(second.observations?.[0]?.callId).not.toBe(first.observations?.[0]?.callId);
    expect(second.observations).toMatchObject([{ seq: 3 }, { seq: 4, success: false }]);
    expect(first.usage).toMatchObject({ inputTokens: 43, outputTokens: 22, cachedInputTokens: 3, cacheWriteInputTokens: 2 });
    expect(second.usage).toMatchObject({ inputTokens: 19, outputTokens: 11, cachedInputTokens: 0 });
    expect(first.toolCoverage).toEqual({ channel: "tools", completeness: "complete", ordering: "source" });
    expect(instance.readFile).not.toHaveBeenCalled();
  });

  it("rejects a native session mismatch and fences further execution", async () => {
    const instance = instanceFor(stream(init, text, result),
      stream(init, text, { ...result, session_id: `local-${"b".repeat(64)}` }));
    await hermesTrainingDriver.run(instance, turn);
    await expect(hermesTrainingDriver.run(instance, { ...turn, wakeId: "w2" })).rejects.toThrow(/different native session/);
    await expect(hermesTrainingDriver.run(instance, { ...turn, wakeId: "w3" })).rejects.toThrow(/cannot be started/);
    expect(instance.exec).toHaveBeenCalledTimes(2);
  });

  it("rejects identical wake retries and attempts from another trial", async () => {
    const instance = instanceFor(stream(init, text, result));
    await hermesTrainingDriver.run(instance, turn);
    await expect(hermesTrainingDriver.run(instance, turn)).rejects.toThrow(/cannot be started/);
    await expect(hermesTrainingDriver.run(instance, { ...turn, trialId: "different" })).rejects.toThrow(/another trial/);
  });

  it("keeps a genuine unmatched dispatch and drops orphan or ambiguous completions", async () => {
    const instance = instanceFor(stream(init, { ...completed, tool_call_id: "orphan" },
      started, { ...started, tool_call_id: "ambiguous" }, { ...started, tool_call_id: "ambiguous" },
      { ...completed, tool_call_id: "ambiguous" }, text, { ...result, replay_gap: true }));
    const reply = await hermesTrainingDriver.run(instance, turn);
    expect(reply.observations).toMatchObject([{ type: "tool.dispatch", tool: "read_file" }]);
    expect(reply.toolCoverage).toEqual({ channel: "tools", completeness: "partial", ordering: "source" });
  });

  it("never treats terminal-only output or a missing usage baseline as measured evidence", async () => {
    const instance = instanceFor(stream(init, { ...result, tokens: undefined }), stream(init, text, result));
    const first = await hermesTrainingDriver.run(instance, turn);
    const second = await hermesTrainingDriver.run(instance, { ...turn, wakeId: "w2" });
    expect(first.observations).toEqual([]);
    expect(first.toolCoverage).toEqual({ channel: "tools", completeness: "absent", ordering: "none" });
    expect(first.usage).toBeNull();
    expect(second.usage).toBeNull();
  });

  it("does not replay earlier tools or charge a repeated or reset counter", async () => {
    const instance = instanceFor(stream(init, started, completed, text, result), stream(init, text, result),
      stream(init, text, { ...result, tokens: { input: 3, output: 1, total: 4, cache_read: 0, cache_write: 0 } }));
    await hermesTrainingDriver.run(instance, turn);
    for (const wakeId of ["w2", "w3"]) {
      await expect(hermesTrainingDriver.run(instance, { ...turn, wakeId })).resolves.toMatchObject({ observations: [], usage: null });
    }
  });

  it("rejects a replayed stream on a new wake", async () => {
    const prior = stream(init, started, completed, text, result);
    const instance = instanceFor(prior, prior);
    await hermesTrainingDriver.run(instance, turn);
    await expect(hermesTrainingDriver.run(instance, { ...turn, wakeId: "w2" })).rejects.toThrow(/stale turn evidence/);
  });

  it.each([
    [stream(init, text), /invalid turn framing/],
    [stream(init, text, result).trimEnd(), /truncated turn stream/],
    [stream(init, text, { ...result, exit_code: 3, error: "Input required" }), /did not complete/],
    [stream(init, result, text, result), /invalid turn framing/]
  ])("rejects unsealed and unsuccessful streams", async (stdout, message) => {
    await expect(hermesTrainingDriver.run(instanceFor(stdout), turn)).rejects.toThrow(message);
  });
});
