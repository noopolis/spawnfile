import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../contracts/grading.js';
import { sha256, stableDigest, type Label } from '../../graders/index.js';
import { cachedScores } from './cache.js';
import { readExclusions, excludeLabels } from './exclusions.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true }))); });
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'grader-cache-'));
  directories.push(directory); return directory;
}
function request(key: string): DecisionRequest {
  return { key, type: 'yes-no', optionLabels: ['yes', 'no'], expectedOptions: ['yes'], instructions: 'Good?', projection: { value: key } };
}
function result(key: string): DecisionResult { return { key, status: 'ok', probabilities: { yes: 0.7, no: 0.3 } }; }
function backend(score: DecisionBackend['score']): DecisionBackend {
  return { identity: async () => ({ backend: 'fake', model: 'm' }), score };
}

describe('raw decision cache', () => {
  it('rescores legacy v1 probabilities instead of reusing optimistic cached values', async () => {
    const dir = await temporary(), input = request('one');
    const { key: _key, ...content } = input;
    const root = join(dir, '.paideia/grader-cache');
    await mkdir(root, { recursive: true });
    const optimistic = { ...result(input.key), probabilities: { yes: 0.99, no: 0.01 } };
    const legacyDigest = stableDigest({ content, identity: 'm', prompt: 'paideia.grader-prompt.v1' });
    await writeFile(join(root, 'm.jsonl'), `${JSON.stringify({ digest: legacyDigest, result: optimistic })}\n`);
    let calls = 0;
    const provider = backend(async requests => { calls++; return requests.map(r => result(r.key)); });
    expect(await cachedScores(dir, provider, 'm', [input], 1)).toEqual([result(input.key)]);
    expect(calls).toBe(1);
    expect(await cachedScores(dir, provider, 'm', [input], 1)).toEqual([result(input.key)]);
    expect(calls).toBe(1);
  });
  it('persists raw results, reuses content under new keys, and separates question/model/projection identity', async () => {
    const dir = await temporary(), calls: DecisionRequest[][] = [];
    const provider = backend(async requests => { calls.push(requests); return requests.map(r => result(r.key)); });
    expect(await cachedScores(dir, provider, 'model-a', [request('one')], 2)).toEqual([result('one')]);
    expect((await readFile(join(dir, '.paideia/grader-cache/model-a.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await cachedScores(dir, provider, 'model-a', [{ ...request('one'), key: 'renamed' }], 2)).toEqual([result('renamed')]);
    expect(calls).toHaveLength(1);
    await cachedScores(dir, provider, 'model-a', [{ ...request('one'), instructions: 'Changed?' }], 2);
    await cachedScores(dir, provider, 'model-a', [request('two')], 2);
    await cachedScores(dir, provider, 'model-b', [request('one')], 2);
    expect(calls).toHaveLength(4);
    expect(await cachedScores(dir, provider, 'model-a', [], 2)).toEqual([]);
  });
  it('bounds concurrent work, preserves input order, and passes cancellation signals to the provider', async () => {
    const dir = await temporary(), signal = new AbortController().signal;
    let active = 0, peak = 0;
    const provider = backend(async (requests, receivedSignal) => {
      expect(receivedSignal).toBe(signal); active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => setTimeout(resolve, 2));
      active--; return requests.map(r => result(r.key));
    });
    const requests = Array.from({ length: 7 }, (_, index) => request(String(index)));
    expect(await cachedScores(dir, provider, 'm', requests, 2, signal)).toEqual(requests.map(r => result(r.key)));
    expect(peak).toBe(2);
  });
  it('retries missing responses next run and refuses omitted result keys', async () => {
    const dir = await temporary(); let calls = 0;
    const provider = backend(async requests => {
      calls++; return requests.map(r => calls === 1 ? { key: r.key, status: 'missing', probabilities: null } : result(r.key));
    });
    expect((await cachedScores(dir, provider, 'm', [request('one')], 1))[0]!.status).toBe('missing');
    expect((await cachedScores(dir, provider, 'm', [request('one')], 1))[0]!.status).toBe('ok');
    expect(calls).toBe(2);
    await expect(cachedScores(dir, backend(async () => []), 'other', [request('one')], 1)).rejects.toThrow('Backend omitted result one');
  });
  it('rejects invalid concurrency, corrupt cache files, IO failures, and cancellation', async () => {
    const dir = await temporary();
    const provider = backend(async () => { throw new Error('must not run'); });
    for (const concurrency of [0, -1, 1.5, NaN]) {
      await expect(cachedScores(dir, provider, 'm', [], concurrency)).rejects.toThrow('concurrency');
    }
    const aborted = new AbortController(); aborted.abort(new Error('cancelled'));
    await expect(cachedScores(dir, provider, 'm', [], 1, aborted.signal)).rejects.toThrow('cancelled');
    const root = join(dir, '.paideia/grader-cache'); await mkdir(root, { recursive: true });
    for (const entry of ['not-json', '{"digest":1,"result":{"status":"ok"}}', '{"digest":"x"}', '{"digest":"x","result":{"status":"bad"}}']) {
      await writeFile(join(root, 'm.jsonl'), entry);
      await expect(cachedScores(dir, provider, 'm', [], 1)).rejects.toThrow();
    }
    await mkdir(join(root, 'directory.jsonl'));
    await expect(cachedScores(dir, provider, 'directory', [], 1)).rejects.toThrow();
    const running = new AbortController();
    const cancelling = backend(async requests => { running.abort(new Error('stopped')); return requests.map(r => result(r.key)); });
    await expect(cachedScores(dir, cancelling, 'cancel', [request('one'), request('two')], 1, running.signal)).rejects.toThrow('stopped');
  });
});

describe('dataset exclusions', () => {
  it('reads both formats, deduplicates paths, and pins exact dataset bytes', async () => {
    const dir = await temporary(), a = join(dir, 'a.yaml'), b = join(dir, 'b.yaml');
    const content = 'schema: paideia.dataset.v1\nrecords:\n  - id: example-a\n';
    await writeFile(a, content);
    await writeFile(b, 'schema: spawnfile.dataset.v1\nexamples:\n  - id: example-b\n');
    const excluded = await readExclusions([b, a, join(dir, '.', 'a.yaml')]);
    expect([...excluded.ids]).toEqual(['example-a', 'example-b']);
    expect(excluded.identities).toEqual([{ dataset: resolve(a), digest: sha256(content) },
      { dataset: resolve(b), digest: sha256(await readFile(b)) }]);
    expect(await readExclusions([])).toEqual({ ids: new Set(), examples: new Set(), identities: [] });
  });
  it('excludes dataset groups across revision IDs and namespaces example matches', async () => {
    const dir = await temporary(), file = join(dir, 'sealed.yaml');
    await writeFile(file, 'schema: paideia.dataset.v1\nid: sealed\nrecords:\n  - {id: story-7-r2, group: story-7}\n');
    const exclusions = await readExclusions([file]);
    const label = (id: string, lineage: string, dataset?: string): Label => ({ id, lineage,
      ...(dataset ? { example: { dataset, id: 'story-7-r2' } } : {}), output: null, context: {}, votes: {}, provenance: {} });
    const labels = [label('revision', 'story-7'), label('record-id', 'story-7-r2'),
      label('example', 'another-lineage', 'sealed'), label('sibling', 'another-lineage'),
      label('path', 'path-lineage', file), label('unrelated', 'other', 'different-dataset')];
    expect(excludeLabels(labels, exclusions).map(label => label.id)).toEqual(['unrelated']);
  });
  it('rejects malformed YAML, schema and record IDs' , async () => {
    const dir = await temporary(), file = join(dir, 'bad.yaml');
    for (const content of ['schema: x\nschema: y', '!unknown {}', 'null', '[]', '42', 'schema: other',
      'schema: paideia.dataset.v1', 'schema: paideia.dataset.v1\nrecords: {}',
      ...['null', '42', '{}', '{ id: 1 }', '{ id: " " }', '{ id: good, group: 1 }', '{ id: good, group: " " }'].map(record => `schema: paideia.dataset.v1\nrecords: [${record}]`)]) {
      await writeFile(file, content);
      await expect(readExclusions([file])).rejects.toThrow();
    }
    await expect(readExclusions([join(dir, 'missing.yaml')])).rejects.toThrow();
  });
  it('excludes matching examples and every revision of their lineage before inference', () => {
    const label = (id: string, lineage: string, example?: string): Label => ({ id, lineage,
      example: example === undefined ? undefined : { dataset: 'any', id: example },
      output: null, context: {}, votes: {}, provenance: {} });
    const labels = [label('a', 'first', 'test-id'), label('b', 'first'), label('c', 'direct'),
      label('d', 'kept', 'other'), label('e', 'unreferenced')];
    expect(excludeLabels(labels, { ids: new Set(['direct']), examples: new Set([JSON.stringify(['any', 'test-id'])]), identities: [] }).map(row => row.id)).toEqual(['d', 'e']);
    expect(excludeLabels(labels, { ids: new Set(), examples: new Set(), identities: [] })).toEqual(labels);
  });
});
