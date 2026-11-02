import { expect, it, vi } from "vitest";

import { createRealmTurns } from "./realmTurns.js";

it("grants one realm in arrival order and keeps other realms independent", async () => {
  const turns = createRealmTurns();
  const order: string[] = [];
  const first = await turns.take("agy");
  const second = turns.take("agy").then((release) => { order.push("second"); return release; });
  const third = turns.take("agy").then((release) => { order.push("third"); return release; });
  const other = await turns.take("other-login");
  await Promise.resolve();
  expect(order).toEqual([]);
  first();
  first();
  (await second)();
  (await third)();
  other();
  expect(order).toEqual(["second", "third"]);
  await expect(turns.take("agy")).resolves.toBeTypeOf("function");
});

it("tells a warm holder once that someone is waiting", async () => {
  const turns = createRealmTurns();
  const onContended = vi.fn();
  const held = await turns.take("agy", { onContended });
  const waiting = [turns.take("agy"), turns.take("agy")];
  expect(onContended).toHaveBeenCalledTimes(1);
  held();
  (await waiting[0]!)();
  (await waiting[1]!)();
});

it("refuses a bounded or cancelled wait without disturbing the queue", async () => {
  vi.useFakeTimers();
  try {
    const turns = createRealmTurns();
    const held = await turns.take("agy");
    const bounded = turns.take("agy", { timeoutMs: 1_000 });
    const controller = new AbortController();
    const cancelled = turns.take("agy", { signal: controller.signal });
    const patient = turns.take("agy");
    vi.advanceTimersByTime(1_000);
    await expect(bounded).rejects.toThrow("one login admits one container at a time");
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    await expect(turns.take("agy", { signal: controller.signal })).rejects.toThrow("cancelled");
    held();
    await expect(patient).resolves.toBeTypeOf("function");
  } finally {
    vi.useRealTimers();
  }
});
