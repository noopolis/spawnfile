import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUIET_GRACE_MS,
  DEFAULT_TARGET_TURNS,
  MIN_TARGET_TURNS,
  evaluateExchangeCompletion,
  resolveTargetTurns,
  waitForConversationExchange
} from "./moltnetExchangeWait.js";
import type { MoltnetApiClient, MoltnetMessage } from "./moltnetWireTypes.js";

const createMessage = (id: string, authorId: string, authorType: string, text: string): MoltnetMessage => ({
  from: { id: authorId, type: authorType },
  id,
  parts: [{ kind: "text", text }]
});

describe("resolveTargetTurns", () => {
  it("defaults to DEFAULT_TARGET_TURNS", () => {
    expect(resolveTargetTurns(undefined)).toBe(DEFAULT_TARGET_TURNS);
  });

  it("clamps below-minimum requests up to MIN_TARGET_TURNS so the close cannot be truncated", () => {
    expect(resolveTargetTurns(1)).toBe(MIN_TARGET_TURNS);
    expect(resolveTargetTurns(2)).toBe(MIN_TARGET_TURNS);
  });

  it("passes through values at or above the minimum", () => {
    expect(resolveTargetTurns(3)).toBe(3);
    expect(resolveTargetTurns(6)).toBe(6);
  });
});

describe("evaluateExchangeCompletion", () => {
  it("stops on turn-cap once the target turn count is reached", () => {
    const result = evaluateExchangeCompletion({
      agentTurnCount: 4,
      elapsedSinceLastAgentMessageMs: 0,
      elapsedSinceStartMs: 1_000,
      quietGraceMs: DEFAULT_QUIET_GRACE_MS,
      targetTurns: 4,
      timeoutMs: 300_000
    });
    expect(result).toEqual({ done: true, reason: "turn-cap" });
  });

  it("does not stop on quiet-timeout before any agent turn has been observed", () => {
    const result = evaluateExchangeCompletion({
      agentTurnCount: 0,
      elapsedSinceLastAgentMessageMs: 999_999,
      elapsedSinceStartMs: 999_999 - 1,
      quietGraceMs: DEFAULT_QUIET_GRACE_MS,
      targetTurns: 4,
      timeoutMs: 1_000_000
    });
    expect(result).toEqual({ done: false, reason: null });
  });

  it("stops on quiet-timeout once the grace period elapses after the last agent turn, below the turn cap", () => {
    const result = evaluateExchangeCompletion({
      agentTurnCount: 2,
      elapsedSinceLastAgentMessageMs: 35_000,
      elapsedSinceStartMs: 60_000,
      quietGraceMs: 35_000,
      targetTurns: 4,
      timeoutMs: 300_000
    });
    expect(result).toEqual({ done: true, reason: "quiet-timeout" });
  });

  it("keeps waiting while within the quiet grace period and under the turn cap and timeout", () => {
    const result = evaluateExchangeCompletion({
      agentTurnCount: 2,
      elapsedSinceLastAgentMessageMs: 10_000,
      elapsedSinceStartMs: 40_000,
      quietGraceMs: 35_000,
      targetTurns: 4,
      timeoutMs: 300_000
    });
    expect(result).toEqual({ done: false, reason: null });
  });

  it("stops on the overall timeout even mid-quiet-period and below the turn cap", () => {
    const result = evaluateExchangeCompletion({
      agentTurnCount: 1,
      elapsedSinceLastAgentMessageMs: 5_000,
      elapsedSinceStartMs: 300_000,
      quietGraceMs: 35_000,
      targetTurns: 4,
      timeoutMs: 300_000
    });
    expect(result).toEqual({ done: true, reason: "timeout" });
  });

  it("prefers turn-cap over quiet-timeout when both conditions are met simultaneously", () => {
    const result = evaluateExchangeCompletion({
      agentTurnCount: 4,
      elapsedSinceLastAgentMessageMs: 40_000,
      elapsedSinceStartMs: 90_000,
      quietGraceMs: 35_000,
      targetTurns: 4,
      timeoutMs: 300_000
    });
    expect(result).toEqual({ done: true, reason: "turn-cap" });
  });
});

describe("waitForConversationExchange", () => {
  const target = { baseUrl: "http://127.0.0.1:8787", expectedMembers: ["eleanor", "sam"], networkId: "memetics_lab", roomId: "eleanor-home" };

  it("collects turns until the turn cap and returns the full transcript", async () => {
    const allMessages = [
      createMessage("seed", "operator", "human", "seed"),
      createMessage("m1", "eleanor", "agent", "propose"),
      createMessage("m2", "sam", "agent", "push back"),
      createMessage("m3", "eleanor", "agent", "close")
    ];
    let call = 0;
    const apiClient: Pick<MoltnetApiClient, "listRoomMessages"> = {
      listRoomMessages: async () => {
        call += 1;
        return allMessages.slice(0, Math.min(1 + call, allMessages.length));
      }
    };
    let clock = 0;
    const sleeps: number[] = [];

    const result = await waitForConversationExchange(
      apiClient as MoltnetApiClient,
      target,
      new Set(["seed"]),
      {
        agentIds: ["eleanor", "sam"],
        intervalMs: 5,
        now: () => clock,
        quietGraceMs: 35_000,
        sleep: async (delayMs) => { sleeps.push(delayMs); clock += 1_000; },
        targetTurns: 3,
        timeoutMs: 300_000
      },
      { info: () => undefined }
    );

    expect(result.endedReason).toBe("turn-cap");
    expect(result.agentTurns.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    expect(result.transcript).toEqual(allMessages);
  });

  it("concludes on quiet-timeout when no further agent turn arrives, without waiting for the turn cap", async () => {
    const allMessages = [
      createMessage("seed", "operator", "human", "seed"),
      createMessage("m1", "eleanor", "agent", "propose"),
      createMessage("m2", "sam", "agent", "agree, no further mention")
    ];
    const apiClient: Pick<MoltnetApiClient, "listRoomMessages"> = {
      listRoomMessages: async () => allMessages
    };
    let clock = 0;

    const result = await waitForConversationExchange(
      apiClient as MoltnetApiClient,
      target,
      new Set(["seed"]),
      {
        agentIds: ["eleanor", "sam"],
        intervalMs: 1_000,
        now: () => clock,
        quietGraceMs: 5_000,
        sleep: async () => { clock += 1_000; },
        targetTurns: 4,
        timeoutMs: 300_000
      },
      { info: () => undefined }
    );

    expect(result.endedReason).toBe("quiet-timeout");
    expect(result.agentTurns.map((message) => message.id)).toEqual(["m1", "m2"]);
  });
});
