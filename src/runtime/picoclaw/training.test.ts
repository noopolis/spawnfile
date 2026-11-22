import { describe, expect, it, vi } from "vitest";
import { adapter } from "./registration.js";
import { picoclawTrainingDriver } from "./training.js";

const homePath = "/var/lib/spawnfile/instances/picoclaw/agent-demo/picoclaw";
const configPath = `${homePath}/compiled config.json`;
const workspacePath = "/var/lib/spawnfile/agents/demo-workspace";
const sessionId = "328ece42-9999-4a2e-84a5-8d40e93206d0";
const sessionKey = `agent:main:cli:direct:${sessionId}`;
const records = `${workspacePath}/sessions/agent_main_cli_direct_${sessionId}`;
const sessionFile = `${records}.jsonl`;
const metaFile = `${records}.meta.json`;
const eventFile = `${homePath}/.spawnfile-training/${sessionId}.jsonl`;
const timestamp = "2026-07-03T13:24:10.123456789Z";
const turn = { trialId: "trial", wakeId: "wake-1", sessionId, text: "--literally $HOME\n実行", timeoutMs: 1200 };
const reply = "Done\n複数行";

const jsonl = (...items: object[]) => items.map(row => `${JSON.stringify(row)}\n`).join("");
const history = (text = turn.text, answer = reply, created = timestamp) => jsonl(
  { role: "user", content: text, created_at: created },
  { role: "assistant", content: answer, model_name: "configured-model", created_at: created }
);
const meta = (key = sessionKey) => JSON.stringify({
  key, summary: "", count: 2, skip: 0, created_at: timestamp, updated_at: timestamp
});
const returned = (answer = reply) => `\n🦞 ${answer}\n`;

// Zerolog file projection of PicoClaw's runtime bus, from the events component.
// The native session JSONL uses provider messages and does not prove execution.
const event = (event_kind: string, event_id: string, fields: object = {}) => ({
  level: "info", component: "events", caller: "pkg/agent/runtime_event_logger.go:182",
  message: `Runtime event: ${event_kind}`, severity: "info", event_kind, event_id,
  event_time: timestamp, time: "2026-07-03T13:24:10Z", session_key: sessionKey,
  channel: "cli", chat_id: "direct", agent_id: "main", turn_id: "main-turn-1", ...fields
});
const start = (text = turn.text) => event("agent.turn.start", "start", { user_len: Buffer.byteLength(text) });
const end = (answer = reply) => event("agent.turn.end", "end", { status: "completed", final_len: Buffer.byteLength(answer) });
const dispatch = event("agent.tool.exec_start", "dispatch", { tool: "write_file", args_count: 2 });
const complete = event("agent.tool.exec_end", "complete", { tool: "write_file", async: false, is_error: false });
const trace = () => jsonl(start(), dispatch, complete, end());

function harness(finish: (files: Map<string, string>) => string) {
  const files = new Map<string, string>();
  const exec = vi.fn(async () => finish(files));
  const readFile = vi.fn(async (file: string) => files.get(file) ?? null);
  return { instance: { configPath, homePath, workspacePath, exec, readFile }, files };
}

describe("PicoClaw training", () => {
  it("uses the installed native agent once with the compiled paths and translates source events", async () => {
    const { instance } = harness(files => {
      files.set(sessionFile, history());
      files.set(metaFile, meta());
      files.set(eventFile, jsonl(start(), { ...dispatch, payload: { api_key: "operator-secret" } }, complete, end()));
      return `unrelated diagnostic: operator-token\n${returned()}`;
    });
    const { signal } = new AbortController();

    const result = await picoclawTrainingDriver.run(instance, { ...turn, signal });

    expect(adapter.training?.adapterId).toBe("picoclaw");
    expect(instance.exec).toHaveBeenCalledExactlyOnceWith(
      ["/usr/local/bin/picoclaw", "agent", "--session", sessionKey, `--message=${turn.text}`],
      { signal, timeoutMs: turn.timeoutMs, env: {
        HOME: homePath, CODEX_HOME: `${homePath}/.codex`, PICOCLAW_HOME: homePath,
        PICOCLAW_CONFIG: configPath, PICOCLAW_LOG_FILE: eventFile, PICOCLAW_LOG_LEVEL: "info",
        PICOCLAW_EVENTS_LOGGING_ENABLED: "true", PICOCLAW_EVENTS_LOGGING_INCLUDE: "agent.turn.*,agent.tool.*",
        PICOCLAW_EVENTS_LOGGING_INCLUDE_PAYLOAD: "false"
      } }
    );
    expect(instance.readFile.mock.calls).toEqual([[sessionFile], [eventFile], [sessionFile], [metaFile], [eventFile]]);
    expect(result.text).toBe(reply);
    expect(result.toolCoverage).toEqual({ channel: "tools", completeness: "partial", ordering: "source" });
    expect(result.observations).toMatchObject([
      { seq: 2, type: "tool.dispatch", tool: "write_file", trialId: turn.trialId, wakeId: turn.wakeId, timestamp },
      { seq: 3, type: "tool.complete", tool: "write_file", trialId: turn.trialId, wakeId: turn.wakeId, success: true, timestamp }
    ]);
    const [sent, finished] = result.observations!;
    expect(sent!.id).toBe(sent!.callId);
    expect(finished!.id).not.toBe(sent!.id);
    expect(finished!.callId).toBe(sent!.callId);
    expect(JSON.stringify(result)).not.toMatch(/operator-|api_key|args_count/);
  });

  it("reuses the session and admits only new source events on a repeated prompt", async () => {
    const { instance } = harness(files => {
      const prior = files.has(sessionFile);
      const occurred = prior ? "2026-07-03T13:25:11Z" : timestamp;
      const currentEvents = [start(), dispatch, complete, end()].map(row => ({
        ...row, event_id: prior ? `new-${row.event_id}` : row.event_id, event_time: occurred
      }));
      files.set(sessionFile, (files.get(sessionFile) ?? "") + history(turn.text, reply, occurred));
      files.set(metaFile, meta());
      files.set(eventFile, (files.get(eventFile) ?? "") + jsonl(...currentEvents));
      return returned();
    });
    const first = await picoclawTrainingDriver.run(instance, turn);
    const second = await picoclawTrainingDriver.run(instance, { ...turn, wakeId: "wake-2" });

    expect(instance.exec.mock.calls).toHaveLength(2);
    expect(second.observations?.map(({ wakeId, seq }) => [wakeId, seq])).toEqual([["wake-2", 6], ["wake-2", 7]]);
    expect(second.observations?.[0]?.id).not.toBe(first.observations?.[0]?.id);
  });

  it("recognizes a freshly completed turn after native history compaction", async () => {
    const { instance, files } = harness(current => {
      current.set(sessionFile, history("retained", "past reply") + history());
      current.set(metaFile, meta());
      return returned();
    });
    files.set(sessionFile, history("pruned", "past reply") + history("retained", "past reply"));
    await expect(picoclawTrainingDriver.run(instance, turn)).resolves.toMatchObject({ text: reply });
  });

  it("ignores histories containing just tool requests, skipped results and diagnostic text", async () => {
    const { instance } = harness(files => {
      files.set(sessionFile, jsonl(
        { role: "user", content: turn.text, created_at: timestamp },
        { role: "assistant", content: "", tool_calls: [{ id: "call_a", type: "function",
          function: { name: "write_file", arguments: "{\"path\":\"output.txt\"}" } }], created_at: timestamp },
        { role: "tool", content: "Tool execution denied by hook", tool_call_id: "call_a", created_at: timestamp },
        { role: "assistant", content: reply, model_name: "configured-model", created_at: timestamp }
      ));
      files.set(metaFile, meta());
      files.set(eventFile, jsonl(start(), event("agent.tool.exec_skipped", "skipped", { tool: "write_file" }),
        { ...dispatch, component: "agent" }, { ...dispatch, caller: "pkg/agent/pipeline_execute.go:182" }, end()));
      files.set(`${workspacePath}/output.txt`, "Preexisting file");
      return returned();
    });
    await expect(picoclawTrainingDriver.run(instance, turn)).resolves.toEqual({
      text: reply, observations: [], toolCoverage: { channel: "tools", completeness: "partial", ordering: "none" }
    });
  });

  it("keeps the bound dispatch with partial coverage when completion evidence is foreign or async", async () => {
    const { instance } = harness(files => {
      files.set(sessionFile, history());
      files.set(metaFile, meta());
      files.set(eventFile, jsonl(start(), dispatch, { ...complete, session_key: "agent:main:foreign" },
        { ...complete, turn_id: "other-turn" }, { ...complete, async: true }, end()) + '{"truncated":');
      return returned();
    });
    const result = await picoclawTrainingDriver.run(instance, turn);
    expect(result.toolCoverage.completeness).toBe("partial");
    expect(result.observations?.map(({ type }) => type)).toEqual(["tool.dispatch"]);
  });

  it("preserves explicit tool failure and cannot pair a same-name completion from a different iteration", async () => {
    const { instance } = harness(files => {
      files.set(sessionFile, history());
      files.set(metaFile, meta());
      files.set(eventFile, jsonl(start(), { ...dispatch, iteration: 1 }, { ...complete, iteration: 2 },
        { ...dispatch, event_id: "other-start", iteration: 3 },
        { ...complete, event_id: "other-end", iteration: 3, is_error: true }, end()));
      return returned();
    });
    const result = await picoclawTrainingDriver.run(instance, turn);
    expect(result.observations?.map(({ type, success }) => [type, success])).toEqual([
      ["tool.dispatch", undefined], ["tool.dispatch", undefined], ["tool.complete", false]
    ]);
  });

  it.each([
    ["missing", ""],
    ["unfinished", jsonl({ role: "user", content: turn.text })],
    ["foreign prompt", history("another prompt")],
    ["ambiguous turn", history() + history("foreign prompt")],
    ["truncated reply", history().slice(0, -1)],
    ["runtime fallback", history(turn.text, "The model returned an empty response. This may indicate a provider error or token limit.")]
  ])("rejects a %s session even when the command exits normally", async (_name, saved) => {
    const { instance } = harness(files => {
      if (saved) files.set(sessionFile, saved);
      files.set(metaFile, meta());
      return returned();
    });
    await expect(picoclawTrainingDriver.run(instance, turn)).rejects.toThrow("did not produce a completed reply");
  });

  it("rejects stale replies, foreign metadata, and a transport ack", async () => {
    const stale = harness(() => returned());
    stale.files.set(sessionFile, history());
    stale.files.set(metaFile, meta());
    const foreign = harness(files => {
      files.set(sessionFile, history());
      files.set(metaFile, meta("agent:main:foreign"));
      return returned();
    });
    const ack = harness(files => {
      files.set(sessionFile, history());
      files.set(metaFile, meta());
      return returned("accepted");
    });

    for (const { instance } of [stale, foreign, ack]) {
      await expect(picoclawTrainingDriver.run(instance, turn)).rejects.toThrow("did not produce a completed reply");
    }
  });

  it("reports partial coverage for unreadable and unclosed event logs", async () => {
    const unreadable = harness(files => {
      files.set(sessionFile, history());
      files.set(metaFile, meta());
      return returned();
    });
    unreadable.instance.readFile.mockImplementation(async file => {
      if (file === eventFile) throw new Error("operator-secret");
      return unreadable.files.get(file) ?? null;
    });
    const unclosed = harness(files => {
      files.set(sessionFile, history());
      files.set(metaFile, meta());
      files.set(eventFile, trace().slice(0, -2));
      return returned();
    });
    for (const { instance } of [unreadable, unclosed]) {
      await expect(picoclawTrainingDriver.run(instance, turn)).resolves.toMatchObject({
        text: reply, observations: [], toolCoverage: { completeness: "partial", ordering: "none" }
      });
    }
  });

  it("withholds native diagnostics on command failure and rejects native turn failure", async () => {
    const failed = harness(() => { throw new Error("operator-secret"); });
    await expect(picoclawTrainingDriver.run(failed.instance, turn)).rejects.toThrow(/^PicoClaw native command failed$/);

    const nonfinal = harness(files => {
      files.set(sessionFile, history());
      files.set(metaFile, meta());
      files.set(eventFile, jsonl(start(), { ...end(), status: "error", error: "operator-secret" }));
      return returned();
    });
    await expect(picoclawTrainingDriver.run(nonfinal.instance, turn)).rejects.toThrow(/^PicoClaw reported an unsuccessful turn$/);
  });

  it("masks credential-shaped content after matching the finished reply", async () => {
    const token = "sk-test_0123456789abcdefghijkl";
    const answer = `The token was ${token}.`;
    const { instance } = harness(files => {
      files.set(sessionFile, history(turn.text, answer));
      files.set(metaFile, meta());
      return returned(answer);
    });
    const result = await picoclawTrainingDriver.run(instance, turn);
    expect(result.text).toBe(`The token was ${"*".repeat(token.length)}.`);
  });
});
