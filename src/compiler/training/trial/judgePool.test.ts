import { expect, it } from "vitest";

import type { TrialWake } from "./types.js";
import { createJudgePool } from "./judgePool.js";

const wake: TrialWake = { state: "completed", acceptanceId: "a", executionId: "e", code: null, text: "{}", usage: [], transcript: null, requestToolCalls: [[]], failure: null };

const harness = (fail = new Set<number>()) => {
  let active = 0, peak = 0;
  const booted: number[] = [];
  const member = (index: number) => {
    if (fail.delete(index)) return Promise.reject(new Error(`judge ${index} did not boot`));
    booted.push(index);
    return Promise.resolve({ container: `j${index}`, read: async () => null, scanCredentials: async () => [],
      wake: async () => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return wake; },
      teardown: async () => null });
  };
  return { booted, member, peak: () => peak };
};

it("judges in parallel up to its size and boots a judge only while every booted one is busy", async () => {
  const { booted, member, peak } = harness();
  const pool = createJudgePool(3, member);
  await pool.wake("one", { deliveryId: "1", timeoutMs: 1 });
  await pool.wake("two", { deliveryId: "2", timeoutMs: 1 });
  expect(booted).toEqual([0]);
  await Promise.all(Array.from({ length: 7 }, (_, i) => pool.wake(String(i), { deliveryId: String(i), timeoutMs: 1 })));
  expect(booted).toEqual([0, 1, 2]);
  expect(peak()).toBe(3);
  await pool.teardown();
});

it("fails the judgment whose judge did not boot, and boots again for the next", async () => {
  const { booted, member } = harness(new Set([1]));
  const pool = createJudgePool(2, member);
  const results = await Promise.allSettled([1, 2].map((i) => pool.wake(String(i), { deliveryId: String(i), timeoutMs: 1 })));
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  await Promise.all([1, 2].map((i) => pool.wake(String(i), { deliveryId: String(i), timeoutMs: 1 })));
  expect(booted).toEqual([0, 1]);
});
