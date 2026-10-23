import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openExperimentStore } from './index.js';
import { contentDigest, digestName } from './content.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(role: 'train' | 'validation' | 'test' = 'train') {
  const root = await mkdtemp(join(tmpdir(), 'paideia-blob-list-')); roots.push(root);
  const store = await openExperimentStore(root);
  await store.createRun({ schema: 'paideia.run.v1', id: 'run', datasetId: 'data', datasetRole: role,
    candidateId: 'candidate', planDigest: 'plan' });
  return { root, store };
}
it('lists authorized immutable references without broadening content visibility', async () => {
  const { root, store } = await fixture(), access = { audience: 'evaluator' as const, phase: 'training' as const };
  expect(await store.listBlobs('run', access)).toEqual([]);
  const protectedBlob = await store.putBlob('run', 'protected');
  const publicBlob = await store.putBlob('run', 'public', 'public');
  const rawBlob = await store.putBlob('run', 'raw', 'raw');
  expect(await store.listBlobs('run', access)).toEqual(expect.arrayContaining([{ ...protectedBlob, visibility: 'evaluator' }, { ...publicBlob, visibility: 'public' }]));
  expect(await store.listBlobs('run', access)).not.toContainEqual({ ...rawBlob, visibility: 'raw' });
  expect(await store.listBlobs('run', { audience: 'optimizer', phase: 'training' })).toEqual([{ ...publicBlob, visibility: 'public' }]);
  const path = join(root, 'runs', digestName(contentDigest('run')), 'blobs', `${digestName(protectedBlob.id)}.json`);
  const metadata = JSON.parse(await readFile(path, 'utf8')); metadata.visibility = 'public';
  await writeFile(path, JSON.stringify(metadata));
  await expect(store.listBlobs('run', access)).rejects.toThrow('integrity');
});
it('enforces sealed test and validation phase fences before listing metadata', async () => {
  const { store } = await fixture('test');
  const blob = await store.putBlob('run', 'sealed');
  await expect(store.listBlobs('run', { audience: 'evaluator', phase: 'training' })).rejects.toThrow();
  await expect(store.listBlobs('run', { audience: 'optimizer', phase: 'training' })).rejects.toThrow();
  await expect(store.listBlobs('run', { audience: 'evaluator', phase: 'test', frozenCandidateIds: ['other'] })).rejects.toThrow();
  expect(await store.listBlobs('run', { audience: 'evaluator', phase: 'test', frozenCandidateIds: ['candidate'] })).toEqual([{ ...blob, visibility: 'evaluator' }]);
  const validation = await fixture('validation');
  await expect(validation.store.listBlobs('run', { audience: 'optimizer', phase: 'training' })).rejects.toThrow();
});
