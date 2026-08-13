import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { renderPiCoreSource } from "./appCoreSource.js";

interface PiManagedAgentInstance {
  handle?: { wake: (event: Record<string, unknown>) => Promise<{ durationMs?: number; text: string }> };
  wake: (event: Record<string, unknown>) => Promise<string>;
}

interface PiManagedAgentConstructor {
  new (
    config: Record<string, unknown>,
    paths: Record<string, unknown>,
    services: Record<string, unknown>
  ): PiManagedAgentInstance;
}

const loadHarness = (room: boolean): { PiManagedAgent: PiManagedAgentConstructor } => {
  const source = renderPiCoreSource();
  const classSource = source.slice(
    source.indexOf("class PiManagedAgent"),
    source.indexOf("const main = async ()")
  );

  return runInNewContext(`${classSource}\n({ PiManagedAgent });`, {
    asObject: (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined,
    asStringOrUndefined: (value: unknown) => typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined,
    controlEventText: (event: Record<string, unknown>) =>
      `[room blue-team] ${String(event.from)}\n\n${String(event.message)}`,
    enrichWakeContext: async (_workspacePath: string, event: Record<string, unknown>) => ({
      activeEnvironment: { networkId: "pitch", roomId: room ? "blue-team" : undefined, surface: "moltnet" },
      context: { networkId: "pitch", roomId: room ? "blue-team" : undefined, surface: "moltnet" },
      eventFrom: event.from,
      isRoomWake: room,
      messageFrom: event.from
    }),
    formatActiveEnvironmentBlock: () => [],
    formatActivityError: (error: unknown) => String(error),
    normalizeAgentEngineKind: () => "grok",
    normalizeWakeKind: (value: unknown) => value === "manual" || value === "message"
      || value === "schedule" || value === "dream" ? value : "message",
    process: { env: {} },
    turnTracePath: () => "/tmp/turn.json"
  }) as { PiManagedAgent: PiManagedAgentConstructor };
};

const createAgent = (room: boolean) => {
  const { PiManagedAgent } = loadHarness(room);
  return new PiManagedAgent(
    { engine: { kind: "grok" }, id: "agent:mapper", name: "Mapper", slug: "mapper" },
    {
      homePath: "/tmp/noopolis-delivery-test/home",
      runtimeHomePath: "/tmp/noopolis-delivery-test/runtime",
      workspacePath: "/tmp/noopolis-delivery-test/workspace"
    },
    { activity: { publish: vi.fn() } }
  );
};

const event = (overrides: Record<string, unknown> = {}) => ({
  context: { networkId: "pitch", roomId: "blue-team", surface: "moltnet" },
  context_id: "moltnet:pitch:room:blue-team",
  from: "world",
  id: "moltnet:social-blue",
  kind: "message",
  text: "Hold the left channel.",
  ...overrides
});

describe("PiManagedAgent authenticated delivery sender normalization", () => {
  it("forwards the authenticated delivery sender for a room wake", async () => {
    const agent = createAgent(true);
    const delivery = {
      contextId: "moltnet:pitch:room:blue-team",
      eventId: "moltnet:social-blue",
      sender: "world",
      target: "agent:mapper"
    };
    const wake = vi.fn(async (input: Record<string, unknown>) => {
      const accepted = input.delivery as typeof delivery;
      if (input.from !== accepted.sender) throw new Error("wake_delivery_invalid");
      return { durationMs: 1, text: "shape left" };
    });
    agent.handle = { wake };

    await expect(agent.wake(event({ delivery, transportText: "social room bytes" })))
      .resolves.toBe("shape left");

    expect(wake.mock.calls[0]?.[0]).toMatchObject({
      delivery,
      from: "world",
      id: delivery.eventId,
      transportText: "social room bytes"
    });
    expect(String(wake.mock.calls[0]?.[0]?.text)).toContain("[room blue-team] world");
  });

  it("prefers authenticated delivery.sender over a conflicting outer sender", async () => {
    const agent = createAgent(true);
    const wake = vi.fn(async (input: Record<string, unknown>) => ({
      durationMs: 1,
      text: String(input.from)
    }));
    agent.handle = { wake };

    await agent.wake(event({
      delivery: {
        contextId: "moltnet:pitch:room:blue-team",
        eventId: "moltnet:social-blue",
        sender: "world",
        target: "agent:mapper"
      },
      from: "untrusted-outer-value"
    }));

    expect(wake.mock.calls[0]?.[0]?.from).toBe("world");
  });

  it("preserves the authenticated sender for a non-room delivery", async () => {
    const agent = createAgent(false);
    const wake = vi.fn(async (input: Record<string, unknown>) => ({ durationMs: 1, text: String(input.from) }));
    agent.handle = { wake };

    await agent.wake(event({
      context: { networkId: "pitch", surface: "moltnet" },
      context_id: "moltnet:pitch:dm:blue:world",
      delivery: {
        contextId: "moltnet:pitch:dm:blue:world",
        eventId: "moltnet:decision-blue",
        sender: "world",
        target: "agent:mapper"
      },
      id: "moltnet:decision-blue"
    }));

    expect(wake.mock.calls[0]?.[0]?.from).toBe("world");
  });

  it("retains the moltnet fallback for a room wake without delivery metadata", async () => {
    const agent = createAgent(true);
    const wake = vi.fn(async (input: Record<string, unknown>) => ({ durationMs: 1, text: String(input.from) }));
    agent.handle = { wake };

    await agent.wake(event({ delivery: undefined }));

    expect(wake.mock.calls[0]?.[0]?.from).toBe("moltnet");
  });
});
