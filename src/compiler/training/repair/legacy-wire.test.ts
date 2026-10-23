import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hashJson } from '../preparation/files.js';
import { readTrainingWitness } from './witness.js';

it.each([
  { image: { build: { paideia: { version: 'old' } }, files: [] } },
  { image: { build: {}, files: [{ destination: 'paideia/dist/cli.js' }] } },
])('gives old external-distribution repair witnesses a clear re-prepare diagnostic', async manifest => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'legacy-witness-')));
  try {
    const file = join(root, 'manifest.json');
    await writeFile(file, JSON.stringify({ manifest, digest: hashJson(manifest) }));
    await expect(readTrainingWitness(file)).rejects.toThrow('re-prepare with Spawnfile');
  } finally { await rm(root, { recursive: true, force: true }); }
});
