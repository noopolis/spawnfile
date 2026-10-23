import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readMeasurementRepair, repairDigest } from './receipt.js';

it('verifies an old receipt before translating its version and retains the original digest', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'legacy-repair-')));
  try {
    const parent = join(root, 'parent'); await mkdir(parent);
    const sha = repairDigest('original');
    const compatibility = { version: 'spawnfile.daimon-dspy-compatibility.v1', components: { 'training-native': sha }, inputs: { source: sha }, digest: '' };
    compatibility.digest = repairDigest(JSON.stringify({ components: compatibility.components, inputs: compatibility.inputs }));
    const receipt = { version: 'paideia.measurement-repair.v1',
      parent: { root: parent, imageId: sha, experimentId: 'parent', executionIdentity: 'execution', manifestDigest: sha,
        checkpoints: { command: sha, training: sha, host: sha, optimizer: sha }, trainingIdentity: 'training' },
      current: { imageId: sha, canonicalSourceDigest: sha, adapterId: 'subject' }, compatibility };
    const digest = repairDigest(JSON.stringify(receipt));
    const file = join(root, 'receipt.json');
    const original = JSON.stringify({ receipt, digest });
    await writeFile(file, original);
    const expected = { parentRoot: parent, out: join(root, 'child'), imageId: sha, canonicalSourceDigest: sha, adapterId: 'subject' };
    expect(await readMeasurementRepair(file, expected)).toMatchObject({ digest, receipt: { version: 'spawnfile.training.measurement-repair.v1' } });
    expect(await readFile(file, 'utf8')).toBe(original);
    receipt.current.adapterId = 'tampered';
    await writeFile(file, JSON.stringify({ receipt, digest }));
    await expect(readMeasurementRepair(file, expected)).rejects.toThrow('integrity mismatch');
    receipt.current.adapterId = 'subject';
    Object.assign(compatibility.components, { native: sha });
    await writeFile(file, JSON.stringify({ receipt, digest: repairDigest(JSON.stringify(receipt)) }));
    await expect(readMeasurementRepair(file, expected)).rejects.toThrow('re-prepare');
  } finally { await rm(root, { recursive: true, force: true }); }
});
