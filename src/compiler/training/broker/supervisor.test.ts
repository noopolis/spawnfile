import { describe, expect, it, vi } from "vitest";

import { createTrainingSlotSupervisor, type TrainingSlotRuntime } from "./supervisor.js";

const nonce = "a".repeat(64);

const stubRuntime = (overrides: Partial<TrainingSlotRuntime> = {}) => {
  const order: string[] = [];
  const state = { leftovers: ["trial-1.json"], generation: 0 };
  const runtime: TrainingSlotRuntime = {
    drain: async () => { order.push("drain"); },
    stop: async () => { order.push("stop"); },
    wipe: async () => { order.push("wipe"); state.leftovers = []; },
    provision: async () => { order.push("provision"); },
    start: async () => { order.push("start"); },
    canaries: async () => { order.push("canaries"); return [{ path: "/run/paideia/context.json", method: "sandboxed-read" as const, result: "denied" as const }]; },
    nextGeneration: async () => { order.push("generation"); state.generation += 1; return state.generation; },
    publishReceipt: async () => { order.push("receipt"); return "/run/training/slot/preflight.json"; },
    log: () => undefined,
    ...overrides
  };
  return { runtime, order, state };
};

describe("training slot recycle", () => {
  it("drains, stops, wipes, re-provisions, restarts, runs canaries and only then publishes the receipt", async () => {
    const { runtime, order, state } = stubRuntime();
    const result = await createTrainingSlotSupervisor({ runtime }).recycle(nonce, 2000);
    expect(order).toEqual(["drain", "stop", "wipe", "provision", "start", "canaries", "generation", "receipt"]);
    // Mutation guard: a recycle that left the previous trial's state behind must not reach a receipt.
    expect(state.leftovers).toEqual([]);
    expect(result).toMatchObject({ ok: true, verb: "recycle", generation: 1, nonce });
  });

  it("refuses a caller that is not the organization uid", async () => {
    const { runtime, order } = stubRuntime();
    await expect(createTrainingSlotSupervisor({ runtime }).recycle(nonce, 2200)).rejects.toThrow(/refused for uid 2200/u);
    expect(order).toEqual([]);
  });

  it("refuses a nonce that is not 32 random bytes of hex", async () => {
    const { runtime, order } = stubRuntime();
    for (const bad of ["", "not-hex", "A".repeat(64), "a".repeat(63)]) {
      await expect(createTrainingSlotSupervisor({ runtime }).recycle(bad, 2000)).rejects.toThrow(/hex nonce/u);
    }
    expect(order).toEqual([]);
  });

  it("never publishes a receipt when a canary is still reachable", async () => {
    const { runtime, order } = stubRuntime({ canaries: async () => { throw Error("Grok slot canary /run/training/output is still readable by the worker uid"); } });
    await expect(createTrainingSlotSupervisor({ runtime }).recycle(nonce, 2000)).rejects.toThrow(/still readable/u);
    expect(order).not.toContain("receipt");
  });

  it("aborts the drain at its deadline instead of recycling under an active turn", async () => {
    const drain = vi.fn(async (signal: AbortSignal) => { await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(Error("drain aborted"))); setTimeout(resolve, 5_000); }); });
    const { runtime, order } = stubRuntime({ drain });
    await expect(createTrainingSlotSupervisor({ runtime, drainTimeoutMs: 20 }).recycle(nonce, 2000)).rejects.toThrow(/drain aborted/u);
    expect(order).not.toContain("wipe");
  });

  it("serializes overlapping recycles instead of interleaving a wipe with a provision", async () => {
    const { runtime, order } = stubRuntime();
    const supervisor = createTrainingSlotSupervisor({ runtime });
    await Promise.all([supervisor.recycle(nonce, 2000), supervisor.recycle("b".repeat(64), 2000)]);
    expect(order.join(",")).toBe(["drain", "stop", "wipe", "provision", "start", "canaries", "generation", "receipt"].concat(
      ["drain", "stop", "wipe", "provision", "start", "canaries", "generation", "receipt"]).join(","));
  });

  it("keeps the queue usable after a failed recycle", async () => {
    let fail = true;
    const { runtime } = stubRuntime({ provision: async () => { if (fail) { fail = false; throw Error("provisioning failed"); } } });
    const supervisor = createTrainingSlotSupervisor({ runtime });
    await expect(supervisor.recycle(nonce, 2000)).rejects.toThrow(/provisioning failed/u);
    await expect(supervisor.recycle("c".repeat(64), 2000)).resolves.toMatchObject({ ok: true });
  });
});
