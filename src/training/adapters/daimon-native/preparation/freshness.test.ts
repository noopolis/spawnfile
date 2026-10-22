import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExperimentSlotFreshness, experimentSlotFreshnessFile } from './freshness.js';
import { prepareNativeSubject } from './subject.js';
import { fakeProvisioner, grokLease, grokSubject, trialRoots } from './fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const stateRoot = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), 'experiment-state-'))); roots.push(root); return root; };
const signal = new AbortController().signal;

/** One trial: Paideia mints through preparation, the slot recycle publishes `generation`, the child accepts. */
async function trial(state: string, index: number, publish = (minimum: number) => minimum) {
  const freshness = createExperimentSlotFreshness(state);
  const slot = { ...grokLease(), index };
  const provisioner = fakeProvisioner(input => {
    const subject = grokSubject(input.freshness!);
    return { ...subject, generation: publish(input.freshness!.minGeneration), broker: { ...subject.broker!, slot: index } };
  });
  const prepared = await prepareNativeSubject({ slot, engine: 'grok', agentId: 'agent:writer', provisioner, freshness, trialRoots: trialRoots(), signal });
  const receipt = { nonce: prepared.broker!.expectedNonce, generation: prepared.generation! };
  await freshness.accept(index, receipt);
  return { prepared, receipt, freshness };
}

describe('createExperimentSlotFreshness', () => {
  it('writes nothing until a broker slot requests a nonce, then keeps state in the experiment root', async () => {
    const state = await stateRoot();
    createExperimentSlotFreshness(state);
    await expect(lstat(join(state, experimentSlotFreshnessFile))).rejects.toMatchObject({ code: 'ENOENT' });
    await trial(state, 1);
    const saved = JSON.parse(await readFile(join(state, experimentSlotFreshnessFile), 'utf8'));
    expect(saved).toEqual({ schema: 'paideia.daimon-native.grok-slot-freshness.v1', slots: { 1: { lastGeneration: 1 } } });
    expect(() => createExperimentSlotFreshness('relative')).toThrow('absolute');
  });

  it('keeps the generation floor across a resumed experiment', async () => {
    const state = await stateRoot();
    const first = await trial(state, 1, () => 7);
    expect(first.prepared.broker!.minGeneration).toBe(1);
    // A resumed runner opens a fresh store on the same experiment state.
    const resumed = await trial(state, 1);
    expect(resumed.prepared.broker!.minGeneration).toBe(8);
    expect(resumed.prepared.broker!.expectedNonce).not.toBe(first.prepared.broker!.expectedNonce);
  });

  it('refuses to replay an accepted slot receipt into a later trial', async () => {
    const state = await stateRoot();
    const { receipt } = await trial(state, 1, () => 5);
    const later = createExperimentSlotFreshness(state);
    await expect(later.accept(1, receipt)).rejects.toThrow('stale: nonce');
    const pending = await later.request(1);
    await expect(later.accept(1, { nonce: receipt.nonce, generation: 6 })).rejects.toThrow('stale: nonce');
    await expect(later.accept(1, { nonce: pending.expectedNonce, generation: 5 })).rejects.toThrow('stale: generation');
    await later.accept(1, { nonce: pending.expectedNonce, generation: 6 });
    // A provisioner whose recycle published a generation below the floor is refused before any bytes are written.
    await expect(trial(state, 1, () => 6)).rejects.toThrow('freshness floor');
  });

  it('sequences four slots concurrently without losing any floor', async () => {
    const state = await stateRoot();
    const slots = [0, 1, 2, 3];
    for (let round = 1; round <= 2; round += 1) {
      const results = await Promise.all(slots.map(index => trial(state, index, minimum => minimum + index)));
      expect(results.map(result => result.prepared.broker!.minGeneration))
        .toEqual(round === 1 ? [1, 1, 1, 1] : slots.map(index => 1 + index + 1));
      expect(new Set(results.map(result => result.receipt.nonce)).size).toBe(4);
    }
    const saved = JSON.parse(await readFile(join(state, experimentSlotFreshnessFile), 'utf8'));
    expect(saved.slots).toEqual({ 0: { lastGeneration: 2 }, 1: { lastGeneration: 4 }, 2: { lastGeneration: 6 }, 3: { lastGeneration: 8 } });
  });
});
