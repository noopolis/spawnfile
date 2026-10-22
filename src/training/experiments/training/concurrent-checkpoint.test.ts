import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TrainingCheckpoint } from './checkpoint.js';
import type { TrainingOptions } from './training.js';

it('queues checkpoint mutations through publication and rolls back a failed reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'training-transactions-'));
  try {
    const options = { id: 'run', baseline: { id: 'baseline' }, native: { adapter: { id: 'fake' } },
      inference: { provider: { id: 'fake' }, model: 'fake' }, budget: { maxMetricCalls: 4, maxProposals: 1 },
      checkpoint: { directory: root, identity: 'execution', resume: false } } as TrainingOptions;
    const checkpoint = (await TrainingCheckpoint.open(options, []))!;
    const publisher = checkpoint as unknown as { save(): Promise<void> };
    const original = publisher.save.bind(publisher);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const save = vi.spyOn(publisher, 'save').mockImplementationOnce(async () => { await gate; await original(); });
    const first = checkpoint.begin('first');
    const second = checkpoint.begin('second');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(save).toHaveBeenCalledTimes(2);
    save.mockImplementationOnce(async () => { throw new Error('disk failed'); });
    await expect(checkpoint.reserveRecovery(1, 'first')).rejects.toThrow('disk failed');
    await checkpoint.reserveRecovery(1, 'first');
    await expect(checkpoint.reserveRecovery(1, 'second')).rejects.toThrow('budget exhausted');
    const saved = JSON.parse(await readFile(join(root, 'training.json'), 'utf8'));
    expect(Object.keys(saved.state.entries)).toEqual(['first', 'second']);
    expect(saved.state.recoveries).toBe(1);
    const reopened = (await TrainingCheckpoint.open({ ...options, checkpoint: { ...options.checkpoint!, resume: true } }, []))!;
    expect((await reopened.begin('first')).restored).toBe(true);
    expect((await reopened.begin('first')).restored).toBe(false);
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});
