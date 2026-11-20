import { describe, expect, it, vi } from "vitest";

import type { NativeTrainingInstance, NativeTrainingTurn } from "../nativeTraining.js";
import { opencodeTrainingDriver } from "./training.js";

const turn: NativeTrainingTurn = {
  sessionId: "harness-session", trialId: "trial", wakeId: "wake-1", text: "--literal input\n  extra space", timeoutMs: 5000
};
const session = "ses_Pilot";
const otherSession = "ses_Foreign";
const actualWorkspace = "/pilot/workspace";
const time = { start: 102, end: 103 };

interface Part {
  id: string;
  type: string;
  messageID: string;
  sessionID: string;
  [key: string]: unknown;
}

const part = (id: string, messageID: string, type: string, extra = {}): Part =>
  ({ id: `prt_${id}`, messageID, sessionID: session, type, ...extra });
const types = {
  "step-start": "step_start", "step-finish": "step_finish", tool: "tool_use", text: "text", reasoning: "reasoning"
};
const measured = { total: 19, input: 7, output: 4, reasoning: 2, cache: { read: 5, write: 1 } };

function stream(parts: Part[], sessionID = session) {
  return parts.map(item => JSON.stringify({ type: types[item.type as keyof typeof types],
    sessionID, part: item, timestamp: 105 })).join("\n") + "\n";
}

function wake(number: number, text: string, tools = number === 1) {
  const user = `msg_User${number}`;
  const action = `msg_Action${number}`;
  const final = `msg_Final${number}`;
  const parts = [
    ...(tools ? [
      part(`StartA${number}`, action, "step-start"),
      part(`Preamble${number}`, action, "text", { text: "Intermediate preamble.", time }),
      part(`Reasoning${number}`, action, "reasoning", { text: "private reasoning", time }),
      part(`Write${number}`, action, "tool", {
        callID: "provider-call", tool: "write", state: {
          status: "completed", input: { filePath: "private input" }, output: "private result", time
        }
      }),
      part(`Read${number}`, action, "tool", {
        callID: "provider-error", tool: "read", state: { status: "error", error: "private error", time }
      }),
      part(`FinishA${number}`, action, "step-finish", { reason: "tool-calls", tokens: measured, cost: 0 })
    ] : []),
    part(`StartF${number}`, final, "step-start"),
    part(`Text${number}`, final, "text", { text: `Final reply ${number}.`, time }),
    part(`FinishF${number}`, final, "step-finish", { reason: "stop", tokens: measured, cost: 0 })
  ];
  const assistant = (id: string, finish: string) => ({
    info: { role: "assistant", id, sessionID: session, parentID: user, time: { created: 101, completed: 104 }, finish },
    parts: parts.filter(item => item.messageID === id)
  });
  return {
    parts,
    messages: [{
      info: { role: "user", id: user, sessionID: session, time: { created: 101 } },
      parts: [part(`Input${number}`, user, "text", { text })]
    }, ...(tools ? [assistant(action, "tool-calls")] : []), assistant(final, "stop")]
  };
}

type Wake = ReturnType<typeof wake>;
function harness(first = wake(1, turn.text)) {
  let title: string;
  const history: Wake["messages"] = [];
  let current = first;
  let overrideStdout: string | undefined;
  let overrideExport: string | undefined;
  const calls: string[][] = [];
  const instance: NativeTrainingInstance = {
    homePath: "/pilot/home", workspacePath: actualWorkspace, configPath: "/pilot/opencode.json", port: 6123,
    readFile: vi.fn(async () => null),
    exec: vi.fn(async (argv, options) => {
      calls.push([...argv]);
      expect(options?.env).toMatchObject({ HOME: "/pilot/home", OPENCODE_CONFIG: "/pilot/opencode.json" });
      expect(options?.env?.XDG_DATA_HOME).toBe("/pilot/home/.local/share");
      expect(options?.timeoutMs).toBeGreaterThan(0);
      if (argv[1] === "-c") {
        expect(argv.slice(5, 13)).toEqual([
          "/usr/local/bin/opencode", "run", "--attach", "http://127.0.0.1:6123",
          "--dir", actualWorkspace, "--format", "json"
        ]);
        if (argv[13] === "--title") title = argv[14]!;
        return overrideStdout ?? stream(current.parts);
      }
      expect(argv.slice(0, 3)).toEqual(["node", "--input-type=module", "-e"]);
      expect(argv.slice(-4, -1)).toEqual(["http://127.0.0.1:6123", actualWorkspace, title]);
      expect(["", session]).toContain(argv.at(-1));
      return overrideExport ?? JSON.stringify({ info: { id: session, title, directory: actualWorkspace },
        messages: [...history, ...current.messages] });
    })
  };
  return {
    instance, calls,
    get title() { return title; },
    next(data: Wake) { history.push(...current.messages); current = data; },
    stdout(value: string) { overrideStdout = value; },
    export(value: string) { overrideExport = value; }
  };
}

describe("OpenCode training driver", () => {
  it("returns the final reply, native completions and measured totals without tool or reasoning payloads", async () => {
    const { instance, calls } = harness();
    const reply = await opencodeTrainingDriver.run(instance, turn);
    expect(calls[0]?.[4]).toBe(turn.text);
    expect(reply).toMatchObject({
      text: "Final reply 1.",
      usage: { inputTokens: 26, outputTokens: 12, cachedInputTokens: 10, cacheWriteInputTokens: 2, reasoningTokens: 4,
        source: "opencode:step-finish" },
      toolCoverage: { channel: "tools", completeness: "partial", ordering: "source" }
    });
    expect(reply.observations?.map(event => [event.type, event.tool, event.success, event.seq])).toEqual([
      ["tool.complete", "write", true, 1], ["tool.complete", "read", false, 2]
    ]);
    for (const row of reply.observations!) {
      expect(row).toMatchObject({ trialId: turn.trialId, wakeId: turn.wakeId, callId: row.id });
      expect(Object.keys(row).sort()).toEqual([
        "callId", "id", "seq", "source", "success", "timestamp", "tool", "trialId", "type", "wakeId"
      ]);
    }
  });

  it("resumes only the exact session and counts only the current wake, even for a repeated prompt", async () => {
    const run = harness();
    await opencodeTrainingDriver.run(run.instance, turn);
    run.next(wake(2, turn.text));
    const reply = await opencodeTrainingDriver.run(run.instance, { ...turn, wakeId: "wake-2" });
    expect(run.calls[2]?.slice(-2)).toEqual(["--session", session]);
    expect(run.calls.flat().includes("--continue")).toBe(false);
    expect(reply.text).toBe("Final reply 2.");
    expect(reply.usage?.inputTokens).toBe(13);
    expect(reply.observations).toEqual([]);
    await expect(opencodeTrainingDriver.run(run.instance, turn)).rejects.toThrow(/cannot accept/);
    await expect(opencodeTrainingDriver.run(run.instance, { ...turn, trialId: "another-trial", wakeId: "new" }))
      .rejects.toThrow(/cannot accept/);
    await expect(opencodeTrainingDriver.run(run.instance, { ...turn, sessionId: "another-session", wakeId: "new" }))
      .rejects.toThrow(/cannot accept/);
    expect(run.calls).toHaveLength(4);
  });

  it("rejects overlapping wakes without letting either claim the other's evidence", async () => {
    const run = harness();
    const first = opencodeTrainingDriver.run(run.instance, turn);
    await expect(opencodeTrainingDriver.run(run.instance, { ...turn, wakeId: "overlap" })).rejects.toThrow(/cannot accept/);
    await expect(first).resolves.toMatchObject({ text: "Final reply 1." });
    expect(run.calls).toHaveLength(2);
  });

  it("rejects a prior stream after resume", async () => {
    const original = wake(1, turn.text);
    const run = harness(original);
    await opencodeTrainingDriver.run(run.instance, turn);
    run.next(wake(2, turn.text));
    run.stdout(stream(original.parts));
    await expect(opencodeTrainingDriver.run(run.instance, { ...turn, wakeId: "wake-2" })).rejects.toThrow(/verified reply/);
  });

  it("does not accept a new stream alone if its persisted transcript belongs to another run", async () => {
    const record = wake(1, turn.text);
    const run = harness(record);
    run.export(JSON.stringify({ info: { id: session, title: "foreign-title", directory: actualWorkspace }, messages: record.messages }));
    await expect(opencodeTrainingDriver.run(run.instance, turn)).rejects.toThrow(/verified reply/);
  });

  it.each(["foreign", "wrong part session", "duplicated", "unclosed", "unbound", "error"] as const)(
    "rejects %s native events without returning gradable output", async kind => {
      const fixture = wake(1, turn.text);
      const run = harness(fixture);
      const parts = [...fixture.parts];
      if (kind === "foreign") run.stdout(stream(parts, otherSession));
      else if (kind === "error") {
        run.stdout(stream(parts) + JSON.stringify({ type: "error", sessionID: session, error: { message: "private provider error" } }));
      } else {
        if (kind === "wrong part session") parts[1] = { ...parts[1]!, sessionID: otherSession };
        if (kind === "duplicated") parts.push(parts[0]!);
        if (kind === "unclosed") {
          parts.pop();
          fixture.messages.at(-1)!.parts.pop();
        }
        if (kind === "unbound") parts[1] = { ...parts[1]!, text: "spoofed reply" };
        run.stdout(stream(parts));
      }
      await expect(opencodeTrainingDriver.run(run.instance, turn))
        .rejects.toThrow(kind === "error" ? /reported a native error/ : /verified reply/);
    }
  );

  it.each(["empty", "partial"])("captures the exact persisted turn when the attached CLI stream is %s", async delivery => {
    const record = wake(1, turn.text);
    const run = harness(record);
    run.stdout(delivery === "empty" ? "" : stream(record.parts.slice(0, 2)));
    const reply = await opencodeTrainingDriver.run(run.instance, turn);
    expect(reply.text).toBe("Final reply 1.");
    expect(reply.observations?.map(event => event.tool)).toEqual(["write", "read"]);
  });

  it("rejects tool-only completion and ignores fabricated tool JSON in final text", async () => {
    const missingText = wake(1, turn.text);
    missingText.parts.find(item => item.id === "prt_Text1")!.text = " ";
    await expect(opencodeTrainingDriver.run(harness(missingText).instance, turn)).rejects.toThrow(/verified reply/);
    const fakeTool = wake(1, turn.text, false);
    fakeTool.parts.find(item => item.type === "text")!.text = JSON.stringify({ type: "tool_use", tool: "write" });
    const reply = await opencodeTrainingDriver.run(harness(fakeTool).instance, turn);
    expect(reply.observations).toEqual([]);
    expect(reply.toolCoverage.ordering).toBe("none");
  });

  it.each([
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    { ...measured, total: 0 },
    { ...measured, total: 18 },
    { ...measured, input: -1 }
  ])("withholds usage when any step lacks measured accounting", async tokens => {
    const fixture = wake(1, turn.text);
    fixture.parts.find(item => item.type === "step-finish")!.tokens = tokens;
    const reply = await opencodeTrainingDriver.run(harness(fixture).instance, turn);
    expect(reply.usage).toBeNull();
  });

  it("does not grade invalid or nonzero shell tools as successful", async () => {
    const fixture = wake(1, turn.text);
    const [invalid, shell] = fixture.parts.filter(item => item.type === "tool");
    Object.assign(invalid!, { tool: "invalid" });
    Object.assign(shell!, { tool: "bash", state: { status: "completed", metadata: { exit: 1 }, time } });
    const reply = await opencodeTrainingDriver.run(harness(fixture).instance, turn);
    expect(reply.observations?.map(event => [event.tool, event.success])).toEqual([["invalid", false], ["bash", false]]);
  });

  it("provides no evidence on native command failure or cancellation", async () => {
    const run = harness();
    vi.mocked(run.instance.exec).mockRejectedValueOnce(new Error("private native stderr"));
    await expect(opencodeTrainingDriver.run(run.instance, turn)).rejects.toThrow("OpenCode native command failed");
    const aborted = new AbortController();
    aborted.abort();
    await expect(opencodeTrainingDriver.run(run.instance, { ...turn, signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(run.instance.exec).toHaveBeenCalledTimes(1);
  });
});
