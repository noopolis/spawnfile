import path from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { renderPiActivitySource } from "./appActivitySource.js";
import { renderPiCliSource } from "./appCliSource.js";
import { renderPiCoreSource } from "./appCoreSource.js";
import { renderPiPreludeSource } from "./appPreludeSource.js";

/**
 * Coverage for the turn-trace<->activity-event JOIN gap: `appCoreSource.ts`
 * (the generated `PiManagedAgent`, used for every `pi`/`codex`/`claude`/
 * `grok`/`agy` agent) has never had a direct test. `daimonCliMemory.ts`'s
 * `assertTraceActivityJoin` needed a live compiled run to prove that
 * `runWake` publishes `agent.turn.started` BEFORE calling `handle.wake()`
 * and `agent.turn.completed` AFTER, with the emitted `wake_id`/`wake_kind`
 * matching the wake event and `trace_path` matching the real
 * `turnTracePath(paths, event.id)` (`appActivitySource.ts`) the generated
 * turn-trace file is written to — the join a human/automated reader needs
 * to correlate an `agent.turn.*` activity event with its `daimon.turn_trace.v1`
 * file on disk. This file proves that wiring directly, in-process, with a
 * fake `handle.wake` — no Docker, no compiled container, no live model.
 *
 * `PiManagedAgent` is sliced out of the full generated app source (the same
 * `runInNewContext` harness pattern `appActivitySource.test.ts` /
 * `appCliSource.test.ts` / `appControlSource.test.ts` already use) together
 * with the small `normalizeAgentEngineKind` helper it calls (owned by
 * `appCliSource.ts`) and the real `turnTracePath`/`formatActivityError`
 * (owned by `appActivitySource.ts`, included unmodified so the asserted
 * `trace_path` is the actual path the real generated app would write to,
 * not a stand-in). The class's own `start()`/adapter construction is
 * bypassed entirely (a "grok" engine config keeps the constructor from
 * touching `PiHarnessAdapter`, which this harness does not supply); the
 * test drives `runWake` directly with a hand-installed fake `handle`.
 */

interface PiManagedAgentInstance {
  config: Record<string, unknown>;
  handle?: { wake: (event: Record<string, unknown>) => Promise<{ durationMs?: number; text: string }> };
  paths: Record<string, unknown>;
  runWake: (event: Record<string, unknown>) => Promise<string>;
  start: () => Promise<void>;
}

interface PiManagedAgentConstructor {
  new (
    config: Record<string, unknown>,
    paths: Record<string, unknown>,
    services: Record<string, unknown>
  ): PiManagedAgentInstance;
}

interface CoreHarness {
  PiManagedAgent: PiManagedAgentConstructor;
}

const loadCoreHarness = (globals: Record<string, unknown> = {}): CoreHarness => {
  const cliSource = renderPiCliSource();
  const cliSlice = cliSource.slice(0, cliSource.indexOf("const stripAnsi ="));

  const preludeSource = renderPiPreludeSource();
  const instructionStart = preludeSource.indexOf("const createAgentInstructions =");
  const instructionEnd = preludeSource.indexOf("const createMemoryEmbeddingProvider =");
  const instructionSlice = preludeSource.slice(instructionStart, instructionEnd);

  const activitySource = renderPiActivitySource();

  const coreSource = renderPiCoreSource();
  const configStart = coreSource.indexOf("const createConfigModel =");
  const configEnd = coreSource.indexOf("const normalizeWakeKind =");
  const configSlice = coreSource.slice(configStart, configEnd);
  const classStart = coreSource.indexOf("class PiManagedAgent");
  const mainStart = coreSource.indexOf("const main = async ()");
  const coreClassSlice = coreSource.slice(classStart, mainStart);

  const harnessSource = [
    cliSlice,
    instructionSlice,
    configSlice,
    activitySource,
    coreClassSlice,
    "({ PiManagedAgent });"
  ].join("\n\n");

  return runInNewContext(harnessSource, {
    console,
    path,
    process: { env: {} },
    ...globals
  }) as CoreHarness;
};

const createConfig = (overrides: Record<string, unknown> = {}) => ({
  engine: { kind: "grok" },
  id: "agent:mapper",
  name: "Mapper",
  slug: "mapper",
  ...overrides
});

const createPaths = () => ({
  homePath: "/tmp/noopolis-core-test/home",
  runtimeHomePath: "/tmp/noopolis-core-test/runtime",
  workspacePath: "/tmp/noopolis-core-test/workspace"
});

const createWakeEvent = (overrides: Record<string, unknown> = {}) => ({
  context: { roomId: "agora" },
  context_id: "moltnet:noopolis:room:agora",
  from: "agent:other",
  id: "wake-1",
  kind: "message",
  text: "hello there",
  ...overrides
});

const countOccurrences = (value: string, needle: string): number =>
  value.split(needle).length - 1;

describe("PiManagedAgent.start instruction assembly", () => {
  it("passes standing instructions and runtime orientation to startAgent exactly once", async () => {
    let adapterOptions: Record<string, unknown> | undefined;
    const startAgent = vi.fn(async (_input: Record<string, unknown>) => ({
      stop: vi.fn(),
      wake: vi.fn()
    }));
    class HarnessAdapter {
      constructor(options: Record<string, unknown>) {
        adapterOptions = options;
      }
      startAgent(input: Record<string, unknown>) {
        return startAgent(input);
      }
    }
    const { PiManagedAgent } = loadCoreHarness({
      PiHarnessAdapter: HarnessAdapter,
      createMemoryRuntimeOptions: () => undefined
    });
    const standingInstructions = [
      "UNIQUE_SYSTEM_DOCUMENT_SENTINEL",
      "## Daimon Runtime Contract",
      "Team context: .spawnfile/team-contexts.md"
    ].join("\n");
    const paths = createPaths();
    const agent = new PiManagedAgent(
      createConfig({
        engine: { kind: "pi" },
        instructions: standingInstructions,
        model: { name: "gpt-5.4-mini", provider: "openai-codex" },
        raw_training_capture: {
          enabled: true,
          retention: { maxTurns: 250 }
        },
        thinking_level: "minimal",
        tools: ["read", "write"]
      }),
      paths,
      { activity: { publish: vi.fn() } }
    );

    await agent.start();

    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(adapterOptions?.thinkingLevel).toBe("minimal");
    expect(adapterOptions?.rawTrainingCapture).toEqual({
      enabled: true,
      retention: { maxTurns: 250 }
    });
    const input = startAgent.mock.calls[0]?.[0];
    const instructions = String(input?.instructions);
    expect(instructions).toBe([
      standingInstructions,
      "",
      "Agent id: agent:mapper",
      `Workspace path: ${paths.workspacePath}`
    ].join("\n"));
    for (const section of [
      "UNIQUE_SYSTEM_DOCUMENT_SENTINEL",
      "## Daimon Runtime Contract",
      "Team context: .spawnfile/team-contexts.md",
      "Agent id: agent:mapper",
      `Workspace path: ${paths.workspacePath}`
    ]) {
      expect(countOccurrences(instructions, section), section).toBe(1);
    }
  });
});

describe("PiManagedAgent.runWake (turn-trace <-> activity-event JOIN)", () => {
  it("preserves authenticated delivery metadata and exact transport text for Daimon", async () => {
    const { PiManagedAgent } = loadCoreHarness();
    const agent = new PiManagedAgent(
      createConfig(),
      createPaths(),
      { activity: { publish: vi.fn() } }
    );
    const delivery = {
      contextId: "dm:arena:member-a:world",
      eventId: "moltnet:message-1",
      sender: "world",
      target: "member-a"
    };
    const transportText = "  exact transport bytes  ";
    const wake = vi.fn(async (_event: Record<string, unknown>) => ({
      durationMs: 1,
      text: ""
    }));
    agent.handle = { wake };

    await agent.runWake(createWakeEvent({ delivery, transportText }));

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]?.[0]).toMatchObject({
      delivery,
      transportText
    });
  });

  it("publishes agent.turn.started before handle.wake() and agent.turn.completed after, sharing wake_id/wake_kind/trace_path", async () => {
    const { PiManagedAgent } = loadCoreHarness();
    const callOrder: string[] = [];
    const publish = vi.fn((event: Record<string, unknown>) => {
      callOrder.push(String(event.type));
      return event;
    });
    const services = { activity: { publish } };
    const paths = createPaths();
    const agent = new PiManagedAgent(createConfig(), paths, services);

    const wake = vi.fn(async (event: Record<string, unknown>) => {
      callOrder.push("handle.wake");
      // handle.wake sees the already-normalized wake payload runWake builds,
      // not the raw enriched event object.
      expect(event).toMatchObject({ id: "wake-1", kind: "message" });
      return { durationMs: 42, text: "reply text" };
    });
    agent.handle = { wake };

    const event = createWakeEvent();
    const result = await agent.runWake(event);

    expect(result).toBe("reply text");
    expect(callOrder).toEqual(["agent.turn.started", "handle.wake", "agent.output.completed", "agent.turn.completed"]);

    const startedCall = publish.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(startedCall).toMatchObject({
      type: "agent.turn.started",
      wake_id: "wake-1",
      wake_kind: "message"
    });

    const completedCall = publish.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const expectedTracePath = path.join(paths.runtimeHomePath as string, "telemetry", "turns", "wake-1.json");
    expect(completedCall).toMatchObject({
      duration_ms: 42,
      output_length: "reply text".length,
      trace_path: expectedTracePath,
      type: "agent.turn.completed",
      wake_id: "wake-1",
      wake_kind: "message"
    });

    // Both turn.started and turn.completed must share the exact wake_id/
    // wake_kind pair — that shared key is the JOIN key a reader uses to
    // correlate the activity stream with the turn_trace file at trace_path.
    expect(startedCall.wake_id).toBe(completedCall.wake_id);
    expect(startedCall.wake_kind).toBe(completedCall.wake_kind);
  });

  it("publishes agent.turn.failed (never agent.turn.completed) with the same trace_path when handle.wake rejects", async () => {
    const { PiManagedAgent } = loadCoreHarness();
    const publish = vi.fn((event: Record<string, unknown>) => event);
    const services = { activity: { publish } };
    const paths = createPaths();
    const agent = new PiManagedAgent(createConfig(), paths, services);
    agent.handle = {
      wake: vi.fn(async () => {
        throw new Error("Bearer sk-proj-abcdefghijklmnopqrstuvwxyz engine crashed");
      })
    };

    const event = createWakeEvent({ id: "wake-2", kind: "schedule" });

    await expect(agent.runWake(event)).rejects.toThrow("engine crashed");

    const types = publish.mock.calls.map((call) => (call[0] as Record<string, unknown>).type);
    expect(types).toEqual(["agent.turn.started", "agent.turn.failed"]);
    expect(types).not.toContain("agent.turn.completed");

    const failedCall = publish.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(failedCall).toMatchObject({
      trace_path: path.join(paths.runtimeHomePath as string, "telemetry", "turns", "wake-2.json"),
      wake_id: "wake-2",
      wake_kind: "schedule"
    });
    // formatActivityError (the real appActivitySource.ts helper, not a
    // stand-in) must have redacted the secret before it reaches the
    // activity stream.
    expect(String(failedCall.error)).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(String(failedCall.error)).toContain("[REDACTED]");
  });

  it("does not publish agent.output.completed when the final text is empty", async () => {
    const { PiManagedAgent } = loadCoreHarness();
    const publish = vi.fn((event: Record<string, unknown>) => event);
    const services = { activity: { publish } };
    const agent = new PiManagedAgent(createConfig(), createPaths(), services);
    agent.handle = { wake: vi.fn(async () => ({ durationMs: 5, text: "   " })) };

    await agent.runWake(createWakeEvent({ id: "wake-3" }));

    const types = publish.mock.calls.map((call) => (call[0] as Record<string, unknown>).type);
    expect(types).toEqual(["agent.turn.started", "agent.turn.completed"]);
  });
});
