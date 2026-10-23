import { describe, expect, it, vi } from "vitest";

import { createTrainingSlotSupervisor, startTrainingSlot, type TrainingSlotRuntime } from "./supervisor.js";

const nonce = "a".repeat(64);

const stubRuntime = (overrides: Partial<TrainingSlotRuntime> = {}) => {
  const order: string[] = [];
  const state = { leftovers: ["trial-1.json"], generation: 0 };
  const runtime: TrainingSlotRuntime = {
    reset: async () => { order.push("drain"); },
    wipe: async () => { order.push("wipe"); state.leftovers = []; },
    provision: async () => { order.push("provision"); },
    canaries: async () => { order.push("canaries"); return [{ path: "/run/spawnfile-training/context.json", method: "sandboxed-read" as const, result: "denied" as const }]; },
    nextGeneration: async () => { order.push("generation"); state.generation += 1; return state.generation; },
    publishReceipt: async () => { order.push("receipt"); return "/run/training/slots/0/preflight.json"; },
    log: () => undefined,
    ...overrides
  };
  return { runtime, order, state };
};

describe("training slot recycle", () => {
  it("resets broker slot state, wipes, reprovisions, canaries and only then publishes the receipt", async () => {
    const { runtime, order, state } = stubRuntime();
    const result = await createTrainingSlotSupervisor({ runtimes: [runtime] }).recycle(0, nonce, 2000);
    expect(order).toEqual(["drain", "wipe", "provision", "canaries", "generation", "receipt"]);
    // Mutation guard: a recycle that left the previous trial's state behind must not reach a receipt.
    expect(state.leftovers).toEqual([]);
    expect(result).toMatchObject({ ok: true, verb: "recycle", generation: 1, nonce });
  });

  it("refuses a caller that is not the organization uid", async () => {
    const { runtime, order } = stubRuntime();
    await expect(createTrainingSlotSupervisor({ runtimes: [runtime] }).recycle(0, nonce, 2200)).rejects.toThrow(/refused for uid 2200/u);
    expect(order).toEqual([]);
  });

  it("refuses a nonce that is not 32 random bytes of hex", async () => {
    const { runtime, order } = stubRuntime();
    for (const bad of ["", "not-hex", "A".repeat(64), "a".repeat(63)]) {
      await expect(createTrainingSlotSupervisor({ runtimes: [runtime] }).recycle(0, bad, 2000)).rejects.toThrow(/hex nonce/u);
    }
    expect(order).toEqual([]);
  });

  it("never publishes a receipt when a canary is still reachable", async () => {
    const { runtime, order } = stubRuntime({ canaries: async () => { throw Error("Grok slot canary /run/training/output is still readable by the worker uid"); } });
    await expect(createTrainingSlotSupervisor({ runtimes: [runtime] }).recycle(0, nonce, 2000)).rejects.toThrow(/still readable/u);
    expect(order).not.toContain("receipt");
  });

  it("aborts the drain at its deadline instead of recycling under an active turn", async () => {
    const drain = vi.fn(async (signal: AbortSignal) => { await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(Error("drain aborted"))); setTimeout(resolve, 5_000); }); });
    const { runtime, order } = stubRuntime({ reset: drain });
    await expect(createTrainingSlotSupervisor({ runtimes: [runtime], drainTimeoutMs: 20 }).recycle(0, nonce, 2000)).rejects.toThrow(/drain aborted/u);
    expect(order).not.toContain("wipe");
  });

  it("serializes overlapping recycles instead of interleaving a wipe with a provision", async () => {
    const { runtime, order } = stubRuntime();
    const supervisor = createTrainingSlotSupervisor({ runtimes: [runtime] });
    await Promise.all([supervisor.recycle(0, nonce, 2000), supervisor.recycle(0, "b".repeat(64), 2000)]);
    expect(order.join(",")).toBe(["drain", "wipe", "provision", "canaries", "generation", "receipt"].concat(
      ["drain", "wipe", "provision", "canaries", "generation", "receipt"]).join(","));
  });

  it("keeps the queue usable after a failed recycle", async () => {
    let fail = true;
    const { runtime } = stubRuntime({ provision: async () => { if (fail) { fail = false; throw Error("provisioning failed"); } } });
    const supervisor = createTrainingSlotSupervisor({ runtimes: [runtime] });
    await expect(supervisor.recycle(0, nonce, 2000)).rejects.toThrow(/provisioning failed/u);
    await expect(supervisor.recycle(0, "c".repeat(64), 2000)).resolves.toMatchObject({ ok: true });
  });
});

describe("training slot start-up", () => {
  /**
   * The first trial is the one whose sealed datasets have never been probed, so
   * it is the one that most needs the evidence. Start-up used to be
   * `provision → start` and nothing else: `canaries` and `publishReceipt` were
   * reachable only through `recycle`, so trial 1 ran with no worker-uid denial
   * evidence at all and a refusal surfaced only after that trial's spend.
   */
  it("canaries the slot and publishes the preflight receipt before it hands the slot over", async () => {
    const { runtime, order } = stubRuntime();
    const result = await startTrainingSlot(runtime, nonce);
    expect(order).toEqual(["canaries", "generation", "receipt"]);
    expect(result).toEqual({ generation: 1, receipt: "/run/training/slots/0/preflight.json", canaries: 1 });
  });

  it("never reaches a receipt when a start-up canary is still reachable", async () => {
    const { runtime, order } = stubRuntime({ canaries: async () => { throw Error("sealed canary is still reachable"); } });
    await expect(startTrainingSlot(runtime, nonce)).rejects.toThrow(/sealed canary is still reachable/u);
    expect(order).not.toContain("receipt");
  });
});

it("recycles slot 1 without invoking any sibling or shared process lifecycle", async () => {
  const slots = Array.from({ length: 4 }, () => stubRuntime());
  await createTrainingSlotSupervisor({ runtimes: slots.map(s => s.runtime) }).recycle(1, nonce, 2000);
  expect(slots[1]!.state.leftovers).toEqual([]);
  for (const index of [0, 2, 3]) {
    expect(slots[index]!.order).toEqual([]);
    expect(slots[index]!.state.leftovers).toEqual(["trial-1.json"]);
  }
});

it("allows different slots to recycle concurrently, while keeping each slot's own order", async () => {
  let reached = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const slots = Array.from({ length: 4 }, () => stubRuntime({ reset: async () => {
    reached++; if (reached === 4) release(); await barrier;
  } }));
  const supervisor = createTrainingSlotSupervisor({ runtimes: slots.map(s => s.runtime) });
  await Promise.all(slots.map((_, index) => supervisor.recycle(index, nonce, 2000)));
  expect(reached).toBe(4);
  for (const slot of slots) expect(slot.order).toEqual(["wipe", "provision", "canaries", "generation", "receipt"]);
});

it("refuses an active turn before deleting files or publishing a new receipt", async () => {
  const { runtime, state, order } = stubRuntime({ reset: async () => { throw Error("engine broker slot busy"); } });
  await expect(createTrainingSlotSupervisor({ runtimes: [runtime] }).recycle(0, nonce, 2000)).rejects.toThrow(/slot busy/);
  expect(state.leftovers).toEqual(["trial-1.json"]);
  expect(order).toEqual([]);
});

it("rejects every invalid or undeclared slot before contacting the broker", async () => {
  const { runtime, order } = stubRuntime();
  for (const slot of [-1, 1, 0.5, NaN, Infinity]) {
    await expect(createTrainingSlotSupervisor({ runtimes: [runtime] }).recycle(slot, nonce, 2000)).rejects.toThrow(/declared slot/);
  }
  expect(order).toEqual([]);
});
