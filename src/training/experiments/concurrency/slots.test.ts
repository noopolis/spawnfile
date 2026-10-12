import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadTrialSlots, SlotPool, trialConcurrency } from './slots.js';
import type { TrialSlot } from './index.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const slots: TrialSlot[] = Array.from({ length: 4 }, (_, index) => ({ index, workerUid: 2200 + index,
  roots: { workspace: `/slots/${index}` }, ports: { base: 20000 + index * 100, count: 100 } }));

it('admits four barrier-controlled trials, holds the fifth, and reuses only a released lease', async () => {
  const pool = new SlotPool(slots);
  const started: number[] = [], finished: number[] = [];
  const gates = Array.from({ length: 5 }, () => barrier());
  const ready = Array.from({ length: 5 }, () => barrier());
  const trials = gates.map(async (gate, index) => {
    const lease = await pool.acquire();
    started.push(index); ready[index]!.resolve();
    await gate.promise;
    finished.push(index); lease.release(true);
    return lease.slot.index;
  });
  await Promise.all(ready.slice(0, 4).map(gate => gate.promise));
  expect(started).toEqual([0, 1, 2, 3]);
  gates[2]!.resolve();
  await ready[4]!.promise;
  expect(started).toEqual([0, 1, 2, 3, 4]);
  gates[4]!.resolve(); gates[3]!.resolve(); gates[1]!.resolve(); gates[0]!.resolve();
  expect(await Promise.all(trials)).toEqual([0, 1, 2, 3, 2]);
  expect(finished[0]).toBe(2);
});

it('quarantines uncertain closure, cancels waiting admission, and fails when no usable slots remain', async () => {
  const pool = new SlotPool(slots.slice(0, 2));
  const one = await pool.acquire(), two = await pool.acquire();
  const aborted = new AbortController();
  const pending = pool.acquire(aborted.signal);
  aborted.abort(new Error('operator'));
  await expect(pending).rejects.toThrow('operator');
  await expect(pool.acquire(aborted.signal)).rejects.toThrow('operator');
  const waiting = pool.acquire();
  one.release(false);
  two.release(true);
  const reused = await waiting;
  expect(reused.slot.index).toBe(1);
  const last = pool.acquire();
  const rejected = expect(last).rejects.toThrow('all slots quarantined');
  expect(() => reused.release(false)).toThrow('all slots quarantined');
  await rejected;
  await expect(pool.acquire()).rejects.toThrow('all slots quarantined');
  expect(() => one.release(true)).toThrow('already released');
  expect(() => new SlotPool([])).toThrow('No usable');
});

it('validates provisioner identity and preserves serial legacy defaults', async () => {
  expect((await loadTrialSlots({ slots })).concurrency).toBe(4);
  expect((await loadTrialSlots({ slots, concurrency: 2 })).concurrency).toBe(2);
  await expect(loadTrialSlots({ concurrency: 0 })).rejects.toThrow();
  expect(() => trialConcurrency(9)).toThrow();
  expect(trialConcurrency(8)).toBe(8);
  await expect(loadTrialSlots({ concurrency: 9 })).rejects.toThrow();
  await expect(loadTrialSlots({ slots, concurrency: 5 })).rejects.toThrow('exceeds');
  await expect(loadTrialSlots({ slots: slots.slice(0, 2) })).rejects.toThrow('exceeds');
  expect((await loadTrialSlots({ slots: slots.slice(0, 2), concurrency: 2 })).concurrency).toBe(2);
  for (const patch of [{ index: 0 }, { workerUid: 2200 }, { ports: slots[0]!.ports }]) {
    await expect(loadTrialSlots({ slots: [slots[0]!, { ...slots[1]!, ...patch }] })).rejects.toThrow('disjoint');
  }
  for (const patch of [{ roots: {} }, { roots: { workspace: 'relative' } }, { ports: { base: 65535, count: 2 } }] as Partial<TrialSlot>[]) {
    await expect(loadTrialSlots({ slots: [{ ...slots[0]!, ...patch }] })).rejects.toThrow();
  }
  const root = await mkdtemp(join(tmpdir(), 'slots-'));
  try {
    const path = join(root, 'slots.json');
    await expect(loadTrialSlots({ slotsFile: path })).rejects.toThrow('ENOENT');
    await writeFile(path, JSON.stringify({ schema: 'spawnfile.training-slots.v1', slots }));
    await expect(loadTrialSlots({ slotsFile: path })).rejects.toThrow('read-only');
    await chmod(path, 0o444);
    expect((await loadTrialSlots({ slotsFile: path })).concurrency).toBe(4);
  } finally { await rm(root, { recursive: true, force: true }); }
  // The development host has no provisioned container slots.
  expect(await loadTrialSlots()).toEqual({ concurrency: 1, pool: undefined, slots: undefined });
  await expect(loadTrialSlots({ concurrency: 2 })).rejects.toThrow('require provisioned');
});
