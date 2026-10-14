import { expect, it } from "vitest";
import { slotFixture as fixture } from "./fixtures.test-helper.js";
import { prepareTrainingSessionSlot } from "./slot.js";

it("binds each lease to one shared broker and fresh native slot reset", async () => {
  for (let index = 0; index < 4; index++) {
    const f = fixture(index, 4), result = await prepareTrainingSessionSlot(f.options, f.dependencies);
    expect(f.dependencies.recycle).toHaveBeenCalledWith(index, f.options.expectedNonce, f.options.signal);
    expect(result.broker).toMatchObject({ slot: index, workerUid: 2200 + index, expectedNonce: f.options.expectedNonce,
      minGeneration: 2, workerConfigVariant: "clocked", workerHomePath: f.slot.roots.workerHome, usageLedgerPath: f.slot.roots.usageLedger });
    expect(result.ports.workerControl).toBe(f.slot.ports.base + 1);
    expect(result.broker.denyPaths).toContain("/run/training/inputs");
    expect(f.dependencies.read).toHaveBeenCalledWith(f.p.preflightReceipt);
  }
});

it("refuses altered descriptor, authority count and stale or foreign reset acknowledgement", async () => {
  const f = fixture();
  await expect(prepareTrainingSessionSlot({ ...f.options, slot: { ...f.slot, workerUid: 9999 } }, f.dependencies)).rejects.toThrow("provisioned");
  f.declaration.slots = 3;
  await expect(prepareTrainingSessionSlot(f.options, f.dependencies)).rejects.toThrow("shared broker");
  f.declaration.slots = 2;
  for (const patch of [{ slot: 0 }, { nonce: "0".repeat(64) }, { receipt: "/other/preflight.json" }, { generation: 1 }]) {
    f.dependencies.recycle.mockResolvedValueOnce({ ...await f.dependencies.recycle(f.slot.index, f.options.expectedNonce, f.options.signal), ...patch });
    await expect(prepareTrainingSessionSlot(f.options, f.dependencies), "lease freshness guarantee").rejects.toThrow("freshness");
  }
  await expect(prepareTrainingSessionSlot({ ...f.options, minGeneration: 0 }, f.dependencies)).rejects.toThrow("freshness request");
  await expect(prepareTrainingSessionSlot({ ...f.options, signal: AbortSignal.abort() }, f.dependencies)).rejects.toThrow();
});

it("refuses native evidence drift including projection, clocked identity and missing denials", async () => {
  for (const patch of [{ slot: 0 }, { nonce: "0".repeat(64) }, { projection_sha256: "0".repeat(64) },
    { sandbox_profile_sha256: "0".repeat(64) }, { grok_executable_sha256: "0".repeat(64) }, { canaries: [] }]) {
    const f = fixture(); Object.assign(f.receipt, patch);
    const accepted = await prepareTrainingSessionSlot(f.options, f.dependencies).then(() => true, () => false);
    expect(accepted, "slot preflight guarantee").toBe(false);
  }
});
