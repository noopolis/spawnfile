import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { externalizeEvaluationJson, hydrateEvaluationJson, openExperimentStore } from './index.js';
import { blobContentPath, contentDigest, digestName, identity, jsonBytes } from './content.js';
import type { BlobReference } from './types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const access = { audience: 'evaluator' as const, phase: 'training' as const };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grading-storage-')); roots.push(root);
  const store = await openExperimentStore(root);
  await store.createRun({ schema: 'paideia.run.v1', id: 'trial', datasetId: 'data', datasetRole: 'train',
    candidateId: 'candidate', planDigest: 'plan' });
  const detail = { schema: 'paideia.atomic-grade.v1', checks: [{ probability: 0.25, unit: 'é'.repeat(32768) }] };
  const check = { status: 'fail', score: 0.25, atomicGrading: detail };
  const inline = { checks: { writing: check }, stages: [{ checks: [check] }], atomicGrading: null, absent: undefined };
  return { root, store, inline };
}
type Encoded = { checks: { writing: { atomicGrading: { blob: BlobReference } } }; stages: { checks: { atomicGrading: unknown }[] }[] };

it('stores grading once across aggregate/stage trees and round-trips inline evidence without mutation', async () => {
  const { root, store, inline } = await fixture();
  const original = structuredClone(inline);
  const encoded = await externalizeEvaluationJson(store, 'trial', inline) as Encoded;
  expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(2000);
  expect(encoded.stages[0]!.checks[0]!.atomicGrading).toEqual(encoded.checks.writing.atomicGrading);
  expect(await readdir(join(root, 'blobs'))).toHaveLength(1);
  expect(await hydrateEvaluationJson(store, encoded, access)).toEqual(inline);
  expect(await hydrateEvaluationJson(store, inline, access)).toEqual(inline);
  expect(inline).toEqual(original);
});

it.each(['tampered', 'missing'] as const)('fails closed when grading content is %s', async mode => {
  const { root, store, inline } = await fixture();
  const encoded = await externalizeEvaluationJson(store, 'trial', inline) as Encoded;
  const path = blobContentPath(root, encoded.checks.writing.atomicGrading.blob);
  if (mode === 'missing') await rm(path);
  else {
    // Valid JSON with the exact original byte count: only digest verification can catch it.
    const original = await readFile(path, 'utf8');
    const changed = original.replace('0.25', '0.75');
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await writeFile(path, changed);
  }
  await expect(hydrateEvaluationJson(store, encoded, access)).rejects.toThrow(mode === 'missing' ? /ENOENT/ : /corrupt/);
});

it('preserves access control and verifies references on hydration', async () => {
  const { store, inline } = await fixture();
  const encoded = await externalizeEvaluationJson(store, 'trial', inline) as Encoded;
  await expect(hydrateEvaluationJson(store, encoded, { audience: 'viewer', phase: 'replay' })).rejects.toThrow('Protected');
  encoded.checks.writing.atomicGrading.blob.size++;
  await expect(hydrateEvaluationJson(store, encoded, access)).rejects.toThrow('integrity');
  for (const detail of [{ schema: 'paideia.atomic-grading-blob.v1' },
    { schema: 'paideia.atomic-grading-blob.v1', blob: null },
    { schema: 'paideia.atomic-grading-blob.v1', blob: {}, extra: 1 }]) {
    await expect(hydrateEvaluationJson(store, { atomicGrading: detail }, access)).rejects.toThrow('Invalid grading');
  }
});

it('bounds grading blobs at 64 MiB and never publishes truncated payloads', async () => {
  const { root, store } = await fixture();
  await expect(externalizeEvaluationJson(store, 'trial', { atomicGrading: { checks: ['x'.repeat(67_108_864)] } }))
    .rejects.toThrow('64 MiB');
  await expect(readdir(join(root, 'blobs'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps persisted evaluations and journals compact, and hydrates authorized replay only', async () => {
  const { root, store, inline } = await fixture();
  await store.appendEvaluation('trial', { id: 'evaluation', report: inline });
  await store.appendEvent('trial', { id: 'completed', payload: inline }, 'evaluator');
  expect(await store.appendEvent('trial', { id: 'completed', payload: inline }, 'evaluator')).toBe('duplicate');
  const runRoot = join(root, 'runs', digestName(contentDigest('trial')));
  expect((await readFile(join(runRoot, 'events.jsonl'))).length).toBeLessThan(2000);
  const replay = await store.readReplay('trial', access);
  expect(replay.evaluations[0]!.report).toEqual(inline);
  expect(replay.events[0]!.payload).toEqual(inline);
  const [reference] = await store.listBlobs('trial', access);
  await rm(blobContentPath(root, reference!));
  // Hidden evaluations are filtered before their references are followed.
  expect((await store.readReplay('trial', { audience: 'viewer', phase: 'replay' })).evaluations).toEqual([]);
  await expect(store.readReplay('trial', access)).rejects.toThrow('ENOENT');
  await expect(store.appendEvaluation('trial', { id: 'evaluation', report: inline })).rejects.toThrow('ENOENT');
});

it('keeps legacy inline publication retries idempotent without rewriting historical bytes', async () => {
  const { root, store, inline } = await fixture();
  await store.appendEvaluation('trial', { id: 'evaluation', report: inline });
  await store.appendEvent('trial', { id: 'completed', payload: inline }, 'evaluator');
  const runRoot = join(root, 'runs', digestName(contentDigest('trial')));
  const evaluationPath = join(runRoot, 'evaluations', `${digestName(contentDigest('evaluation'))}.json`);
  const eventPath = join(runRoot, 'events.jsonl');
  const evaluation = { id: 'evaluation', report: inline, visibility: 'evaluator' };
  const event = { id: 'completed', sequence: 1, payload: inline, visibility: 'evaluator' };
  const evaluationBytes = jsonBytes({ ...evaluation, digest: identity(evaluation) });
  const eventBytes = `${jsonBytes({ ...event, digest: identity(event) })}\n`;
  await writeFile(evaluationPath, evaluationBytes);
  await writeFile(eventPath, eventBytes);
  await store.appendEvaluation('trial', { id: 'evaluation', report: inline });
  expect(await store.appendEvent('trial', { id: 'completed', payload: inline }, 'evaluator')).toBe('duplicate');
  expect(await readFile(evaluationPath, 'utf8')).toBe(evaluationBytes);
  expect(await readFile(eventPath, 'utf8')).toBe(eventBytes);
  await expect(store.appendEvaluation('trial', { id: 'evaluation', report: { changed: true } })).rejects.toThrow('Immutable');
  await expect(store.appendEvent('trial', { id: 'completed', payload: { changed: true } }, 'evaluator')).rejects.toThrow('Conflicting');
  const tampered = JSON.parse(evaluationBytes); tampered.report = { changed: true };
  await writeFile(evaluationPath, JSON.stringify(tampered));
  await expect(store.appendEvaluation('trial', { id: 'evaluation', report: inline })).rejects.toThrow('integrity');
});
