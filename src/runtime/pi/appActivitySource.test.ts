import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderPiActivitySource } from "./appActivitySource.js";

interface ActivityBroker {
  list: (filter?: string | null, tail?: string | null) => Record<string, unknown>[];
  publish: (event: Record<string, unknown>) => Record<string, unknown>;
}

interface ActivityHarness {
  createGeneratedTurnTrace: (input: Record<string, unknown>) => Record<string, any>;
  createActivityBroker: () => ActivityBroker;
  formatActivityError: (error: unknown) => string;
}

const loadHarness = (): ActivityHarness =>
  runInNewContext(
    `${renderPiActivitySource()}\n({ createActivityBroker, createGeneratedTurnTrace, formatActivityError });`,
    { createHash, path }
  ) as ActivityHarness;

describe("renderPiActivitySource", () => {
  it("creates a filtered and tailed activity buffer with normalized event fields", () => {
    const { createActivityBroker } = loadHarness();
    const broker = createActivityBroker();

    broker.publish({
      agent_id: "agent:mapper",
      agent_name: "Mapper",
      agent_slug: "mapper",
      type: "agent.loaded"
    });
    broker.publish({
      agent_id: "agent:reviewer",
      agent_name: "Reviewer",
      agent_slug: "reviewer",
      type: "agent.turn.started",
      wake_id: "wake-1",
      wake_kind: "message"
    });
    broker.publish({
      agent_id: "agent:mapper",
      agent_name: "Mapper",
      agent_slug: "mapper",
      type: "agent.turn.completed",
      wake_id: "wake-2",
      wake_kind: "schedule"
    });

    expect(broker.list("mapper", "1")).toEqual([
      expect.objectContaining({
        agent_id: "agent:mapper",
        sequence: 3,
        type: "agent.turn.completed",
        version: "spawnfile.activity.v1",
        wake_id: "wake-2",
        wake_kind: "schedule"
      })
    ]);
    expect(broker.list("Reviewer", "10")).toEqual([
      expect.objectContaining({
        agent_slug: "reviewer",
        sequence: 2,
        wake_kind: "message"
      })
    ]);
    expect(typeof broker.list(null, null)[0]?.created_at).toBe("string");
  });

  it("redacts token-like values and host paths from activity errors", () => {
    const { formatActivityError } = loadHarness();

    const redacted = formatActivityError(
      'failed Bearer abcdefghijklmnop sk-proj-abcdefghijklmnopqrstuvwxyz /Users/apresmoi/.codex/auth.json {"refresh_token":"super-secret"} {"session_key":"secret-session"} {"authorization":"basic abcdef"} {"credential":"cred-secret"} session key: agent@moltnet:secret-session'
    );

    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("[path]");
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("/Users/apresmoi");
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("secret-session");
    expect(redacted).not.toContain("basic abcdef");
    expect(redacted).not.toContain("cred-secret");
  });

  it("creates secret-safe generated turn trace records", () => {
    const { createGeneratedTurnTrace } = loadHarness();

    const trace = createGeneratedTurnTrace({
      config: {
        id: "agent:mapper",
        memory: { bank_id: "floor" },
        model: {
          auth_method: "codex",
          name: "gpt-5.4-mini",
          provider: "openai-codex"
        }
      },
      engine: "codex",
      engineMs: 25,
      event: {
        context_id: "moltnet:noopolis:room:agora:thread:t_1",
        id: "msg-1",
        kind: "message",
        from: "moltnet",
        context: {
          access_token: "access-token-secret",
          api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz",
          authorization: "Bearer abcdefghijklmnop",
          networkId: "noopolis",
          nested: {
            password: "nested-password-secret",
            path: "/Users/apresmoi/private/file.txt"
          },
          roomId: "agora",
          session_key: "agent@moltnet:secret-session"
        }
      },
      memoryPrepareMs: 3,
      memoryPrepareStatus: "completed",
      memoryRecall: {
        redaction_count: 0,
        selected_count: 1,
        token_budget_used: 10,
        total_candidates: 2
      },
      outputText: "ok",
      prompt: "Memory context\nActive environment context:\nsk-proj-abcdefghijklmnopqrstuvwxyz",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "completed"
    });

    expect(trace).toEqual(expect.objectContaining({
      agent_id: "agent:mapper",
      schema: "daimon.turn_trace.v1",
      turn_id: "msg-1"
    }));
    expect(trace.engine).toEqual({
      auth_method: "codex",
      kind: "codex",
      model: "gpt-5.4-mini",
      provider: "openai-codex"
    });
    expect(trace.prompt).toEqual(expect.objectContaining({
      has_active_environment: true,
      has_memory_context: true
    }));
    expect(trace.session.thread_id).toBe("moltnet:noopolis:room:agora:thread:t_1");
    expect(trace.wake.context_id).toBe("moltnet:noopolis:room:agora:thread:t_1");
    expect(trace.wake.context).toEqual(expect.objectContaining({
      access_token: "[REDACTED]",
      api_key: "[REDACTED]",
      authorization: "[REDACTED]",
      networkId: "noopolis",
      session_key: "[REDACTED]"
    }));
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("access-token-secret");
    expect(serialized).not.toContain("nested-password-secret");
    expect(serialized).not.toContain("secret-session");
    expect(serialized).not.toContain("/Users/apresmoi");
    expect(trace.memory.prepare.recall.selected_count).toBe(1);
  });

  it("redacts secret-like values from failed generated turn traces", () => {
    const { createGeneratedTurnTrace } = loadHarness();

    const trace = createGeneratedTurnTrace({
      config: {
        id: "agent:mapper",
        memory: { bank_id: "floor" },
        model: {
          auth_method: "codex",
          name: "gpt-5.4-mini",
          provider: "openai-codex"
        }
      },
      engine: "codex",
      error: 'stderr {"session_key":"secret-session"} {"authorization":"basic abcdef"} {"credential":"cred-secret"} session key: agent@moltnet:secret-session',
      event: {
        context_id: "moltnet:noopolis:room:agora",
        id: "msg-2",
        kind: "message",
        from: "moltnet"
      },
      outputText: "",
      prompt: "Memory context\nActive environment context:",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "failed"
    });

    const serialized = JSON.stringify(trace);
    expect(trace.error.message).toContain("[REDACTED]");
    expect(serialized).not.toContain("secret-session");
    expect(serialized).not.toContain("basic abcdef");
    expect(serialized).not.toContain("cred-secret");
  });
});
