import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MNEME_RECALL_MODE_ENV,
  createMemoryRuntime,
  readMemoryContext,
  type MemoryRuntime
} from "@noopolis/mneme";

import { renderPiCliSource } from "./appCliSource.js";

/**
 * Coverage for the DAIMON-TURN-CAUSAL gap: `CliEngineAgentHandle.wake()`
 * (the handle used for every non-"pi" engine kind — codex/claude/grok/agy,
 * including the fake-engine E2E fixtures under test/fixtures/e2e/office-sim)
 * previously never stamped `turn.input.submitted`/`turn.output.completed`,
 * so a real compiled run's daimon `telemetry/causal.jsonl` only ever
 * contained `control.wake.accepted`. `stampTurnInputSubmitted`/
 * `stampTurnOutputCompleted` are injected as mocks here — daimon's own
 * `turnCausal.ts`/`causalEvents.ts` already prove their internal shape and
 * chaining; this file proves `appCliSource.ts` calls them at the right
 * point in the wake lifecycle, with the right `agentId`/`event`/`turnId`
 * wiring, mirroring `PiAgentHandle.wake()`'s own placement.
 */

interface CliHandleConstructor {
  new (config: Record<string, unknown>, paths: Record<string, unknown>): {
    wake: (event: Record<string, unknown>) => Promise<{ durationMs: number; text: string }>;
    stop: () => void;
  };
}

interface CliHarness {
  CliEngineAgentHandle: CliHandleConstructor;
}

interface CliHarnessMocks {
  createMemoryRuntime: ReturnType<typeof vi.fn>;
  createMemoryRuntimeOptions: ReturnType<typeof vi.fn>;
  readMemoryContext: ReturnType<typeof vi.fn>;
  runCliEngine: ReturnType<typeof vi.fn>;
  stampTurnInputSubmitted: ReturnType<typeof vi.fn>;
  stampTurnOutputCompleted: ReturnType<typeof vi.fn>;
  writeTurnTrace: ReturnType<typeof vi.fn>;
}

const createHarnessMocks = (overrides: Partial<CliHarnessMocks> = {}): CliHarnessMocks => ({
  createMemoryRuntime: vi.fn(() => {
    throw new Error("createMemoryRuntime should not be called when config.memory is unset");
  }),
  createMemoryRuntimeOptions: vi.fn((config: { memory?: unknown }) => config.memory),
  readMemoryContext: vi.fn(() => ({ roomId: undefined })),
  runCliEngine: vi.fn(async () => ({ durationMs: 12, text: "final reply text" })),
  stampTurnInputSubmitted: vi.fn(async () => ({ event_id: "daimon:moltnet:msg-1:turn.input.submitted" })),
  stampTurnOutputCompleted: vi.fn(async () => ({ event_id: "daimon:moltnet:msg-1:turn.output.completed" })),
  writeTurnTrace: vi.fn(async () => undefined),
  ...overrides
});

const loadCliHarness = (mocks: CliHarnessMocks): CliHarness => {
  const harnessSource = [
    renderPiCliSource(),
    "({ CliEngineAgentHandle });"
  ].join("\n");

  return runInNewContext(harnessSource, {
    console,
    createGeneratedTurnTrace: vi.fn(() => ({})),
    createIdentityPrompt: vi.fn(() => "identity prompt"),
    createMemoryRuntime: mocks.createMemoryRuntime,
    createMemoryRuntimeOptions: mocks.createMemoryRuntimeOptions,
    normalizeMemoryAgentId: (value: unknown) =>
      typeof value === "string" ? value.replace(/^agent:/u, "") : value,
    process: { env: {} },
    readMemoryContext: mocks.readMemoryContext,
    runCliEngine: mocks.runCliEngine,
    stampTurnInputSubmitted: mocks.stampTurnInputSubmitted,
    stampTurnOutputCompleted: mocks.stampTurnOutputCompleted,
    writeTurnTrace: mocks.writeTurnTrace
  }) as CliHarness;
};

const createConfig = (overrides: Record<string, unknown> = {}) => ({
  engine: { kind: "grok" },
  id: "agent:mapper",
  instructions: "Be helpful.",
  name: "Mapper",
  slug: "mapper",
  ...overrides
});

const createPaths = () => ({
  homePath: "/tmp/noopolis-cli-test/home",
  runtimeHomePath: "/tmp/noopolis-cli-test/runtime",
  workspacePath: "/tmp/noopolis-cli-test/workspace"
});

const createWakeEvent = (overrides: Record<string, unknown> = {}) => ({
  from: "agent:other",
  id: "moltnet:msg-1",
  kind: "message",
  text: "hello there",
  ...overrides
});

describe("CliEngineAgentHandle turn causal stamping", () => {
  it("stamps turn.input.submitted before the engine call and turn.output.completed after, chained via event.id", async () => {
    const callOrder: string[] = [];
    const mocks = createHarnessMocks({
      runCliEngine: vi.fn(async () => {
        callOrder.push("runCliEngine");
        return { durationMs: 12, text: "final reply text" };
      }),
      stampTurnInputSubmitted: vi.fn(async () => {
        callOrder.push("stampTurnInputSubmitted");
        return { event_id: "daimon:moltnet:msg-1:turn.input.submitted" };
      }),
      stampTurnOutputCompleted: vi.fn(async () => {
        callOrder.push("stampTurnOutputCompleted");
        return { event_id: "daimon:moltnet:msg-1:turn.output.completed" };
      })
    });
    const { CliEngineAgentHandle } = loadCliHarness(mocks);
    const paths = createPaths();
    const handle = new CliEngineAgentHandle(createConfig(), paths);
    const event = createWakeEvent();

    const result = await handle.wake(event);

    expect(result.text).toBe("final reply text");
    expect(callOrder).toEqual(["stampTurnInputSubmitted", "runCliEngine", "stampTurnOutputCompleted"]);

    expect(mocks.stampTurnInputSubmitted).toHaveBeenCalledTimes(1);
    expect(mocks.stampTurnInputSubmitted.mock.calls[0]?.[0]).toMatchObject({
      agentId: "mapper",
      event,
      prepared: undefined,
      runtimeHomePath: paths.runtimeHomePath
    });
    expect(typeof mocks.stampTurnInputSubmitted.mock.calls[0]?.[0].promptText).toBe("string");

    expect(mocks.stampTurnOutputCompleted).toHaveBeenCalledTimes(1);
    expect(mocks.stampTurnOutputCompleted.mock.calls[0]?.[0]).toMatchObject({
      agentId: "mapper",
      causeEventId: "daimon:moltnet:msg-1:turn.input.submitted",
      outputText: "final reply text",
      runtimeHomePath: paths.runtimeHomePath,
      turnId: "moltnet:msg-1"
    });
  });

  it("strips the agent: prefix off config.id so principal_id never double-prefixes (agent:agent:<slug>)", async () => {
    const mocks = createHarnessMocks();
    const { CliEngineAgentHandle } = loadCliHarness(mocks);
    const handle = new CliEngineAgentHandle(createConfig({ id: "agent:reviewer" }), createPaths());

    await handle.wake(createWakeEvent());

    expect(mocks.stampTurnInputSubmitted.mock.calls[0]?.[0].agentId).toBe("reviewer");
    expect(mocks.stampTurnOutputCompleted.mock.calls[0]?.[0].agentId).toBe("reviewer");
  });

  it("does not stamp turn.output.completed when the CLI engine fails (success-path only, matching daimon's own convention)", async () => {
    const mocks = createHarnessMocks({
      runCliEngine: vi.fn(async () => {
        throw new Error("grok exited 1");
      })
    });
    const { CliEngineAgentHandle } = loadCliHarness(mocks);
    const handle = new CliEngineAgentHandle(createConfig(), createPaths());

    await expect(handle.wake(createWakeEvent())).rejects.toThrow("grok exited 1");

    expect(mocks.stampTurnInputSubmitted).toHaveBeenCalledTimes(1);
    expect(mocks.stampTurnOutputCompleted).not.toHaveBeenCalled();
  });

  it("passes the mneme prepared-turn result through to stampTurnInputSubmitted when memory is configured", async () => {
    const prepared = {
      packet: {},
      principal: { agentId: "mapper", scope: "global" },
      promptText: "prepared prompt with recalled memory",
      recall: { redactionCount: 0, selectedEventIds: ["mneme:evt-1"], tokenBudgetUsed: 10, totalCandidates: 1 }
    };
    const memory = {
      prepareTurn: vi.fn(async () => prepared),
      recordTurn: vi.fn(async () => undefined)
    };
    const mocks = createHarnessMocks({
      createMemoryRuntime: vi.fn(() => memory)
    });
    const { CliEngineAgentHandle } = loadCliHarness(mocks);
    const handle = new CliEngineAgentHandle(createConfig({ memory: { bank_id: "memory", runtime_home_path: "/tmp/mem" } }), createPaths());

    await handle.wake(createWakeEvent());

    expect(mocks.stampTurnInputSubmitted.mock.calls[0]?.[0]).toMatchObject({
      prepared,
      promptText: expect.stringContaining("prepared prompt with recalled memory")
    });
  });

  it("chains cause_event_ids through a schedule-kind wake's own synthesized event id (no moltnet id available)", async () => {
    const mocks = createHarnessMocks();
    const { CliEngineAgentHandle } = loadCliHarness(mocks);
    const handle = new CliEngineAgentHandle(createConfig(), createPaths());
    const scheduleEvent = createWakeEvent({ from: "scheduler", id: "schedule-agent:mapper-171234", kind: "schedule" });

    await handle.wake(scheduleEvent);

    expect(mocks.stampTurnInputSubmitted.mock.calls[0]?.[0].event).toBe(scheduleEvent);
    expect(mocks.stampTurnOutputCompleted.mock.calls[0]?.[0].turnId).toBe("schedule-agent:mapper-171234");
  });

  it("normalizes engine.kind 'scripted' to the CLI engine handle (not the default 'pi' fallback) and passes the full config to runCliEngine", async () => {
    const mocks = createHarnessMocks();
    const { CliEngineAgentHandle } = loadCliHarness(mocks);
    const config = createConfig({
      engine: { kind: "scripted" },
      engine_command: "engine/office-engine.mjs"
    });
    const handle = new CliEngineAgentHandle(config, createPaths());

    await handle.wake(createWakeEvent());

    expect(mocks.runCliEngine).toHaveBeenCalledTimes(1);
    const [engineArg, , , configArg] = mocks.runCliEngine.mock.calls[0];
    expect(engineArg).toBe("scripted");
    expect(configArg).toEqual(config);
  });
});

/**
 * Coverage for the memory-content-in-prompt seam and the B70-through-
 * generated-code seam: mneme's own `runtime.test.ts`/`recallMode.test.ts`
 * prove `prepareTurn`'s recall selection and `MNEME_RECALL_MODE` on/off/
 * shuffled behavior in isolation; neither knows `createCliEnginePrompt`
 * (this file's own generated prompt builder) exists. Daimon's harnesses
 * don't own `createCliEnginePrompt` either. This block wires the REAL
 * `@noopolis/mneme` `createMemoryRuntime` (still mocking `runCliEngine`/
 * `stampTurn*`/`writeTurnTrace`, which are daimon's/this file's own
 * concerns, already covered above) through the generated
 * `CliEngineAgentHandle.wake()` and asserts (a) recalled memory text
 * actually reaches the prompt handed to `runCliEngine`, and (b)
 * `MNEME_RECALL_MODE` gates what recalled text lands there — the only B70
 * assertion that exercises the real generated-code path rather than
 * mneme's runtime in isolation.
 */
describe("CliEngineAgentHandle wired to the real @noopolis/mneme memory runtime", () => {
  const MARKER_TEXT = "The launch date is 2026-08-01, codename NOVA.";
  // Four topically unrelated decoys (no "launch"/"date"/"nova" overlap with
  // the query below, so every one of them always ranks BELOW the marker
  // memory — recall.ts's scoreEvent counts query/word overlap). mneme's own
  // recall token budget floors at 128 (support.ts's clampTokenBudget); with
  // the marker plus 4 decoys x 2 events each (claimed+observed) as
  // candidates, the combined representations comfortably exceed that floor,
  // so at least one decoy is left unselected under "on" mode (see recall.ts's
  // `runRecall` selection loop) and sits in the pool `shuffled` mode
  // substitutes from. Every decoy shares the "toner cartridge" phrase so the
  // assertion doesn't depend on exactly which one is excluded/injected.
  const DECOY_TEXTS = [
    "Printer note one: the office printer on the third floor needs a new toner cartridge before Monday.",
    "Printer note two: facilities confirmed the toner cartridge order will ship by courier next week.",
    "Printer note three: the toner cartridge inventory in the west wing supply closet is now low.",
    "Printer note four: remember to recycle the empty toner cartridge box after replacement."
  ];
  const QUERY_TEXT = "What is the NOVA launch date status?";

  const tempRoots: string[] = [];
  let previousRunId: string | undefined;

  const tempDir = async (): Promise<string> => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-appcli-mneme-"));
    tempRoots.push(directory);
    return directory;
  };

  beforeEach(() => {
    previousRunId = process.env.NOOPOLIS_RUN_ID;
    process.env.NOOPOLIS_RUN_ID = "run-app-cli-source-real-mneme";
  });

  afterEach(async () => {
    delete process.env[MNEME_RECALL_MODE_ENV];
    if (previousRunId === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = previousRunId;
    await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const seedMemory = async (runtime: MemoryRuntime, eventId: string, requestText: string, outputText: string) => {
    const principal = { agentId: "mapper", scope: "global" as const };
    await runtime.recordTurn({
      outputText,
      principal,
      prompt: { principal, rawHint: "seed", sections: [] },
      request: { context: {}, eventId, kind: "manual", text: requestText },
      result: "completed",
      toolEvents: []
    });
  };

  const runQueryWithMode = async (mode: "on" | "off" | "shuffled"): Promise<string> => {
    const root = await tempDir();
    // MNEME_RECALL_MODE is resolved once, at JsonlMemoryRuntime construction
    // (see recallMode.ts's doc comment on JsonlMemoryRuntimeConfig), so it
    // must be set before createMemoryRuntime is called. recordTurn itself
    // (used below to seed memory) never consults recall mode — only
    // prepareTurn does — so seeding is unaffected by which mode we target.
    process.env[MNEME_RECALL_MODE_ENV] = mode;
    // The tightest budget mneme's runtime allows (support.ts's
    // clampTokenBudget floors at 128) keeps at least one decoy candidate out
    // of "on" mode's selection once the marker and the other decoys have
    // already used most of it — see recall.ts's `runRecall` selection loop —
    // which is what leaves it sitting in the pool for shuffled mode to
    // substitute in.
    const runtime = createMemoryRuntime({ agentId: "mapper", runtimeHomePath: root, tokenBudget: 128 });
    await seedMemory(runtime, "daimon:seed-marker", "Log the launch details please.", MARKER_TEXT);
    for (const [index, decoyText] of DECOY_TEXTS.entries()) {
      await seedMemory(runtime, `daimon:seed-decoy-${index}`, `General weekly status note ${index}.`, decoyText);
    }

    let capturedPrompt = "";
    const mocks = createHarnessMocks({
      createMemoryRuntime: vi.fn(() => runtime),
      readMemoryContext: vi.fn(readMemoryContext),
      runCliEngine: vi.fn(async (_engine: unknown, prompt: string) => {
        capturedPrompt = prompt;
        return { durationMs: 5, text: "engine reply" };
      })
    });
    const { CliEngineAgentHandle } = loadCliHarness(mocks);
    const handle = new CliEngineAgentHandle(
      createConfig({ memory: { bank_id: "memory", runtime_home_path: root } }),
      createPaths()
    );

    await handle.wake(createWakeEvent({ id: "moltnet:query-1", text: QUERY_TEXT }));
    return capturedPrompt;
  };

  it("mode on: the real recalled memory text lands in the generated prompt", async () => {
    const prompt = await runQueryWithMode("on");

    expect(prompt).toContain("codename NOVA");
  });

  it("mode off: prepareTurn skips recall entirely, so no recalled memory text lands in the prompt", async () => {
    const prompt = await runQueryWithMode("off");

    expect(prompt).not.toContain("codename NOVA");
    expect(prompt).not.toContain("toner cartridge");
  });

  it("mode shuffled: the true recalled memory never lands in the prompt, but a same-scope decoy does", async () => {
    const prompt = await runQueryWithMode("shuffled");

    expect(prompt).not.toContain("codename NOVA");
    expect(prompt).toContain("toner cartridge");
  });
});
