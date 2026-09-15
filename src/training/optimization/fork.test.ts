import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OptimizationCheckpoint, restoredDspyEvidence } from './checkpoint.js';
import { DSPY_SCHEMA, startSchema, type DspyRequest } from './protocol.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'paideia-fork-')); roots.push(root); return root; }
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function fixture() {
  const parent = await directory(), child = await directory();
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: 'parent', components: { prompt: 'original' },
    trainCaseIds: ['train'], validationCaseIds: ['validation'], budget: { maxMetricCalls: 4, maxProposals: 2 } });
  const old = { directory: parent, identity: 'old-execution', resume: false };
  const checkpoint = await OptimizationCheckpoint.open(start, old);
  const request: DspyRequest = { schema: DSPY_SCHEMA, kind: 'request', id: 'call-1', method: 'evaluate',
    params: { caseId: 'validation', split: 'validation', components: { prompt: 'original' } } };
  const entry = await checkpoint.begin(request, start.budget);
  await checkpoint.complete(entry, { score: 0.88, feedback: '', output: '', captureId: 'native-old' });
  const pending = { ...request, id: 'call-2', params: { ...request.params, split: 'train' as const, caseId: 'train' } };
  await checkpoint.begin(pending, start.budget);
  const bytes = await readFile(join(parent, 'host.json'));
  const options = { directory: child, identity: 'new-execution', resume: false,
    fork: { directory: parent, identity: old.identity, id: start.id, digest: `sha256:${'a'.repeat(64)}`, hostDigest: sha(bytes) } };
  return { parent, child, start, options, request, pending, bytes };
}

it('forks immutable callback evidence with explicit lineage and cumulative pending attempts', async () => {
  const f = await fixture();
  const fork = await OptimizationCheckpoint.open({ ...f.start, id: 'child' }, f.options);
  const first = await fork.begin(f.request, f.start.budget);
  expect(first.result).toEqual({ score: 0.88, feedback: '', output: '', captureId: 'native-old' });
  expect(first.attempts).toBe(1);
  const pending = await fork.begin(f.pending, f.start.budget);
  expect(pending.attempts).toBe(2);
  expect(restoredDspyEvidence(fork).reservations).toMatchObject([
    { id: 'call-1', attempts: 1, completed: true }, { id: 'call-2', attempts: 2, completed: false },
  ]);
  const persisted = JSON.parse(await readFile(join(f.child, 'host.json'), 'utf8'));
  expect(persisted.lineage).toEqual({ fork: f.options.fork, childId: 'child' });
  expect(await readFile(join(f.parent, 'host.json'))).toEqual(f.bytes);
  const resumed = await OptimizationCheckpoint.open({ ...f.start, id: 'child' }, { ...f.options, resume: true });
  expect(resumed.entries).toEqual(fork.entries);
  await expect(resumed.begin(f.pending, { ...f.start.budget, maxMetricCalls: 3 })).rejects.toThrow('Cumulative');
  await expect(OptimizationCheckpoint.open({ ...f.start, id: 'child' }, { ...f.options, resume: true, fork: undefined })).rejects.toThrow('identity');
});

it('rejects corrupted parent bytes, changed semantic request, and existing child history', async () => {
  const f = await fixture(), start = { ...f.start, id: 'child' };
  await expect(OptimizationCheckpoint.open(start, { ...f.options,
    fork: { ...f.options.fork, hostDigest: `sha256:${'b'.repeat(64)}` } })).rejects.toThrow('digest');
  await expect(OptimizationCheckpoint.open({ ...start, components: { prompt: 'tampered' } }, f.options)).rejects.toThrow('identity');
  await expect(OptimizationCheckpoint.open({ ...start, budget: { ...start.budget, maxMetricCalls: 9 } }, f.options)).rejects.toThrow('identity');
  await OptimizationCheckpoint.open(start, f.options);
  await expect(OptimizationCheckpoint.open(start, f.options)).rejects.toThrow('EEXIST');
  const body = JSON.parse(f.bytes.toString()); body.entries[0].result.score = 1;
  const corrupt = Buffer.from(JSON.stringify(body)); await writeFile(join(f.parent, 'host.json'), corrupt);
  await expect(OptimizationCheckpoint.open(start, { ...f.options, directory: await directory(),
    fork: { ...f.options.fork, hostDigest: sha(corrupt) } })).rejects.toThrow('integrity');
});

it('finishes interrupted fork initialization on resume but never creates a missing ordinary resume journal', async () => {
  const f = await fixture(), start = { ...f.start, id: 'child' };
  await expect(OptimizationCheckpoint.open(start, { ...f.options, resume: true, fork: undefined })).rejects.toThrow('ENOENT');
  await writeFile(join(f.child, 'optimizer.json'), '{}');
  await expect(OptimizationCheckpoint.open(start, { ...f.options, resume: true })).rejects.toThrow('after optimizer initialization');
  await rm(join(f.child, 'optimizer.json'));
  const imported = await OptimizationCheckpoint.open(start, { ...f.options, resume: true });
  expect(imported.entries).toHaveLength(2);
  expect(imported.entries[0]!.attempts).toBe(1);
  const resumed = await OptimizationCheckpoint.open(start, { ...f.options, resume: true });
  expect(resumed.entries).toEqual(imported.entries);
  await expect(OptimizationCheckpoint.open(start, { ...f.options, directory: await directory(), resume: true,
    fork: { ...f.options.fork, directory: '/missing-parent' } })).rejects.toThrow('ENOENT');
});
