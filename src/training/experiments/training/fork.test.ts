import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrainingCheckpoint } from './checkpoint.js';
import type { TrainingOptions } from './training.js';
import { repairDigest } from '../repair/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('resumes interrupted training fork initialization exactly once with cumulative counters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-training-fork-')); roots.push(root);
  const options = { id: 'parent', baseline: { id: 'baseline' }, native: { adapter: { id: 'fixture' } },
    inference: { provider: { id: 'fixture' }, model: 'model' }, budget: { maxMetricCalls: 4, maxProposals: 1 },
    checkpoint: { directory: join(root, 'parent'), identity: 'original', maxRecoveryAttempts: 2 } } as TrainingOptions;
  const parent = await TrainingCheckpoint.open(options, []);
  await parent!.reserveRecovery(2);
  const bytes = await readFile(join(options.checkpoint!.directory, 'training.json'));
  const saved = JSON.parse(bytes.toString('utf8'));
  const fork = { directory: options.checkpoint!.directory, identity: 'original', id: 'parent',
    digest: repairDigest('optimizer'), hostDigest: repairDigest('host'), trainingDigest: repairDigest(bytes),
    trainingIdentity: saved.state.identity, receiptDigest: repairDigest('receipt') };
  const child = { ...options, id: 'child', checkpoint: { ...options.checkpoint!, directory: join(root, 'child'), identity: 'upgraded', resume: true, fork } };
  await expect(TrainingCheckpoint.open({ ...child, checkpoint: { ...child.checkpoint, fork: undefined } }, [])).rejects.toThrow('ENOENT');
  for (const name of ['host.json', 'optimizer.json']) {
    await writeFile(join(child.checkpoint.directory, name), '{}');
    await expect(TrainingCheckpoint.open(child, [])).rejects.toThrow('after optimizer initialization');
    await rm(join(child.checkpoint.directory, name));
  }
  const imported = await TrainingCheckpoint.open(child, []);
  expect(imported!.inheritedTrialIds).toEqual([]);
  await imported!.reserveRecovery(2);
  const resumed = await TrainingCheckpoint.open(child, []);
  await expect(resumed!.reserveRecovery(2)).rejects.toThrow('Cumulative');
  expect(await readFile(join(fork.directory, 'training.json'))).toEqual(bytes);
  const changed = JSON.parse(bytes.toString()); changed.state.recoveries = -1;
  await writeFile(join(fork.directory, 'training.json'), JSON.stringify(changed));
  await expect(TrainingCheckpoint.open({ ...child, checkpoint: { ...child.checkpoint, directory: join(root, 'other') } }, [])).rejects.toThrow('digest');
});
