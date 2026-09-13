import { appendFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openExperimentStore } from './index.js';
import type { ReadAccess, RunManifest } from './types.js';
import { contentDigest, digestName, identity, jsonBytes } from './content.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const manifest: RunManifest = { schema: 'paideia.run.v1', id: 'run', datasetId: 'data', datasetRole: 'train', candidateId: 'candidate', planDigest: 'plan', recordId: 'record' };
const evaluator: ReadAccess = { audience: 'evaluator', phase: 'training' };
const operator: ReadAccess = { audience: 'operator', phase: 'replay' };
async function fixture(record = manifest) {
  const root = await mkdtemp(join(tmpdir(), 'paideia-store-')); roots.push(root);
  const store = await openExperimentStore(root);
  await store.createRun(record);
  const runRoot = join(root, 'runs', digestName(contentDigest(record.id)));
  return { root, runRoot, store };
}
describe('immutable evidence storage', () => {
  it('persists content-addressed blobs with authoritative access metadata', async () => {
    const { root, store } = await fixture();
    const reference = await store.putBlob('run', 'Protected reference');
    expect((await store.readBlob(reference, evaluator)).toString()).toBe('Protected reference');
    await expect(store.readBlob(reference, { audience: 'viewer', phase: 'replay' })).rejects.toThrow(/Protected blob/);
    expect(await store.putBlob('run', Buffer.from('Protected reference'))).toEqual(reference);
    expect(await readdir(join(root, 'blobs'))).toHaveLength(1);
    await expect(store.readBlob({ ...reference, size: 1 }, evaluator)).rejects.toThrow(/reference integrity/);
    const publicReference = await store.putBlob('run', 'Public output', 'public');
    expect((await store.readBlob(publicReference, { audience: 'optimizer', phase: 'training' })).toString()).toBe('Public output');
    await writeFile(join(root, 'blobs', digestName(reference.digest)), 'Corrupted');
    await expect(store.readBlob(reference, operator)).rejects.toThrow(/corrupt/);
  });
  it('rejects reference metadata corruption rather than trusting caller visibility', async () => {
    const { runRoot, store } = await fixture();
    const reference = await store.putBlob('run', 'raw', 'raw');
    await expect(store.readBlob(reference, evaluator)).rejects.toThrow(/Protected/);
    const path = join(runRoot, 'blobs', `${digestName(reference.id)}.json`);
    const metadata = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    metadata.visibility = 'public';
    await writeFile(path, JSON.stringify(metadata));
    await expect(store.readBlob(reference, operator)).rejects.toThrow(/integrity/);
  });
  it('persists separate immutable evaluations and replay never rewrites history', async () => {
    const { store, runRoot } = await fixture();
    await store.appendEvaluation('run', { id: 'original', report: { status: 'unknown' } }, 'public');
    await store.appendEvaluation('run', { id: 'rescore-v2', report: { status: 'pass' } }, 'public');
    await store.appendEvaluation('run', { id: 'private', report: { label: 'secret' } }, 'evaluator');
    await store.appendEvent('run', { id: 'native', payload: { source: 'cli', seq: 17, type: 'output' } });
    await store.appendEvent('run', { id: 'projection', payload: { text: 'Done' } }, 'public');
    const before = await readFile(join(runRoot, 'events.jsonl'));
    const replay = await store.readReplay('run', { audience: 'viewer', phase: 'replay' });
    expect(replay.events.map(event => event.id)).toEqual(['projection']);
    expect(replay.redactedEvents).toBe(1);
    expect(replay.evaluations).toHaveLength(2);
    expect(replay.completeness).toBe('complete');
    expect(await readFile(join(runRoot, 'events.jsonl'))).toEqual(before);
    await expect(store.appendEvaluation('run', { id: 'original', report: { status: 'pass' } })).rejects.toThrow(/Immutable/);
    expect((await store.readReplay('run', operator)).events[0]!.payload).toEqual({ source: 'cli', seq: 17, type: 'output' });
    expect((await store.readReplay('run', evaluator)).evaluations).toHaveLength(3);
  });
  it('serializes concurrent writes and makes exact duplicate events idempotent', async () => {
    const { root, store } = await fixture();
    const other = await openExperimentStore(root);
    expect(await Promise.all([
      store.appendEvent('run', { id: 'a', payload: { callId: 'native-a' } }),
      other.appendEvent('run', { id: 'b', payload: { callId: 'native-b' } }),
    ])).toEqual(['appended', 'appended']);
    expect(await store.appendEvent('run', { id: 'a', payload: { callId: 'native-a' } })).toBe('duplicate');
    const settled = await Promise.allSettled([
      store.appendEvent('run', { id: 'a', payload: 'changed' }),
      store.appendEvent('run', { id: 'c', payload: null }),
    ]);
    expect(settled.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    const replay = await store.readReplay('run', operator);
    expect(replay.events.map(event => event.sequence)).toEqual([1, 2, 3]);
    await expect(store.appendEvent('run', { id: 'c', payload: null }, 'public')).rejects.toThrow(/Conflicting replay/);
  });
  it('exposes torn tails without accepting a truncated observation or healing on read', async () => {
    const { store, runRoot } = await fixture();
    expect((await store.readReplay('run', operator)).events).toEqual([]);
    await store.appendEvent('run', { id: 'complete', payload: true });
    await appendFile(join(runRoot, 'events.jsonl'), '{"id":"unfinished"');
    const before = await readFile(join(runRoot, 'events.jsonl'));
    const replay = await store.readReplay('run', operator);
    expect(replay.events).toHaveLength(1);
    expect(replay.completeness).toBe('torn-tail');
    expect(replay.ignoredTailBytes).toBeGreaterThan(0);
    expect(await readFile(join(runRoot, 'events.jsonl'))).toEqual(before);
    await expect(store.appendEvent('run', { id: 'next', payload: true })).rejects.toThrow(/interrupted tail/);
  });
  it('detects corrupt completed lines, sequence gaps, duplicated identities and evaluation tampering', async () => {
    const { store, runRoot } = await fixture();
    const path = join(runRoot, 'events.jsonl');
    await writeFile(path, 'not json\n');
    await expect(store.readReplay('run', operator)).rejects.toThrow(/Corrupt complete/);
    const body = { id: 'a', sequence: 1, visibility: 'raw', payload: null };
    await writeFile(path, `${jsonBytes({ ...body, digest: 'invalid' })}\n`);
    await expect(store.readReplay('run', operator)).rejects.toThrow(/integrity/);
    const second = { ...body, sequence: 2 };
    await writeFile(path, `${jsonBytes({ ...body, digest: identity(body) })}\n${jsonBytes({ ...second, digest: identity(second) })}\n`);
    await expect(store.readReplay('run', operator)).rejects.toThrow(/Duplicate persisted/);
    await writeFile(path, '');
    await store.appendEvaluation('run', { id: 'score', report: { score: 0 } });
    const reportPath = join(runRoot, 'evaluations', `${digestName(contentDigest('score'))}.json`);
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    report.report = { score: 1 };
    await writeFile(reportPath, JSON.stringify(report));
    await expect(store.readReplay('run', operator)).rejects.toThrow(/evaluation integrity/);
  });
  it('keeps original run roles immutable and rejects corrupt stored manifests', async () => {
    const { store, runRoot } = await fixture();
    await store.createRun(manifest);
    await expect(store.createRun({ ...manifest, datasetRole: 'test' })).rejects.toThrow(/Immutable/);
    const path = join(runRoot, 'manifest.json');
    const value = JSON.parse(await readFile(path, 'utf8')) as { manifest: RunManifest };
    value.manifest.datasetRole = 'test';
    await writeFile(path, JSON.stringify(value));
    await expect(store.readReplay('run', operator)).rejects.toThrow(/manifest integrity/);
  });
  it('never follows a symlink inserted into a stored namespace', async () => {
    const { store, runRoot, root } = await fixture();
    await symlink(root, join(runRoot, 'evaluations'));
    await expect(store.appendEvaluation('run', { id: 'x', report: null })).rejects.toThrow(/symlink/);
    await expect(store.readReplay('run', operator)).rejects.toThrow(/symlink/);
  });
});
describe('sealed dataset access', () => {
  it('requires a frozen candidate and correct phase for test, including baseline runs', async () => {
    const { store } = await fixture({ ...manifest, datasetRole: 'test' });
    const reference = await store.putBlob('run', 'hidden test', 'public');
    for (const access of [evaluator, operator,
      { audience: 'optimizer', phase: 'test', frozenCandidateIds: ['candidate'] },
      { audience: 'viewer', phase: 'test', frozenCandidateIds: ['candidate'] },
      { audience: 'evaluator', phase: 'test', frozenCandidateIds: ['different'] },
    ] as ReadAccess[]) await expect(store.readBlob(reference, access)).rejects.toThrow();
    const frozen: ReadAccess = { audience: 'evaluator', phase: 'test', frozenCandidateIds: ['baseline', 'candidate'] };
    expect((await store.readBlob(reference, frozen)).toString()).toBe('hidden test');
    const published: ReadAccess = { audience: 'viewer', phase: 'replay', frozenCandidateIds: ['candidate'], releaseTestResults: true };
    expect((await store.readReplay('run', published)).manifest.datasetRole).toBe('test');
  });
  it('never reveals validation examples to optimizer access', async () => {
    const { store } = await fixture({ ...manifest, datasetRole: 'validation' });
    await expect(store.readReplay('run', { audience: 'optimizer', phase: 'validation' })).rejects.toThrow(/Optimizer/);
    expect((await store.readReplay('run', { audience: 'evaluator', phase: 'validation' })).manifest.datasetRole).toBe('validation');
  });
});

it('does not leak protected manifest metadata into viewer or optimizer projections', async () => {
  const { store } = await fixture({ ...manifest, metadata: { expectedAnswer: 'hidden label' } });
  expect((await store.readReplay('run', evaluator)).manifest.metadata).toEqual({ expectedAnswer: 'hidden label' });
  for (const audience of ['viewer', 'optimizer'] as const) {
    const replay = await store.readReplay('run', { audience, phase: 'training' });
    expect(replay.manifest).not.toHaveProperty('metadata');
    expect(replay.redactedMetadata).toBe(true);
  }
});

it('defaults evaluation reports to protected visibility until explicitly approved', async () => {
  const { store } = await fixture();
  await store.appendEvaluation('run', { id: 'private-by-default', report: { hiddenLabel: 'secret' } });
  expect((await store.readReplay('run', evaluator)).evaluations).toHaveLength(1);
  expect((await store.readReplay('run', { audience: 'viewer', phase: 'replay' })).evaluations).toEqual([]);
  expect((await store.readReplay('run', { audience: 'optimizer', phase: 'training' })).evaluations).toEqual([]);
});
