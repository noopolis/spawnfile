import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { DecisionBackend, DecisionRequest } from '../../contracts/grading.js';
import { stableDigest } from '../../graders/index.js';
import { createOllamaDecision, createJevDecision } from '../../inference/decision/index.js';
import { cachedScores } from './cache.js';

// Historical key inputs from origin/main (624a972), independent of production constants.
const prompt = 'paideia.grader-prompt.v4';
const request: DecisionRequest = { key: 'new-key', type: 'yes-no', optionLabels: ['yes', 'no'],
  expectedOptions: ['yes'], instructions: 'Good?', projection: { value: 'one' } };
const { key: _key, ...content } = request;
const digest = stableDigest({ content, identity: 'model', prompt });
it('hits old-directory entries even with a partial current cache, prefers current entries and writes new scores only to current', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-cache-'));
  try {
    const old = join(directory, '.paideia/grader-cache'), current = join(directory, '.spawnfile-training/grader-cache');
    await mkdir(old, { recursive: true }); await mkdir(current, { recursive: true });
    const result = { key: 'old-key', status: 'ok' as const, probabilities: { yes: 0.7, no: 0.3 } };
    const source = JSON.stringify({ digest, result }) + '\n';
    await writeFile(join(old, 'model.jsonl'), source);
    await writeFile(join(current, 'model.jsonl'), '');
    const score = vi.fn<DecisionBackend['score']>(async requests => requests.map(r => ({ ...result, key: r.key })));
    const backend: DecisionBackend = { identity: async () => ({ backend: 'fake', model: 'm' }), score };
    expect(await cachedScores(directory, backend, 'model', [request], 1)).toEqual([{ ...result, key: request.key }]);
    expect(score).not.toHaveBeenCalled();
    const preferred = { ...result, probabilities: { yes: 0.9, no: 0.1 } };
    await writeFile(join(current, 'model.jsonl'), JSON.stringify({ digest, result: preferred }) + '\n');
    expect(await cachedScores(directory, backend, 'model', [request], 1)).toEqual([{ ...preferred, key: request.key }]);
    expect(score).not.toHaveBeenCalled();
    await cachedScores(directory, backend, 'model', [{ ...request, instructions: 'Changed?' }], 1);
    expect(score).toHaveBeenCalledTimes(1);
    expect(await readFile(join(old, 'model.jsonl'), 'utf8')).toBe(source);
    expect((await readFile(join(current, 'model.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
    await writeFile(join(current, 'model.jsonl'), '');
    await writeFile(join(old, 'model.jsonl'), JSON.stringify({ digest, result: { key: 'x', status: 'missing', probabilities: null } }));
    await cachedScores(directory, backend, 'model', [request], 1);
    expect(score).toHaveBeenCalledTimes(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('retains origin/main Ollama and Jev backend identity hash inputs', async () => {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ollama = createOllamaDecision({ endpoint: 'http://localhost', model: 'm', fetch: async url =>
    new Response(JSON.stringify(String(url).endsWith('/tags') ? { models: [{ name: 'm', digest: 'installed' }] } : { version: '0.34.0' })) });
  expect(await ollama.identity()).toEqual({ backend: 'ollama-logprobs', model: 'm', digest: hash({
    modelDigest: 'installed', contextTokens: 16384, truncate: false, shift: false, protocol: prompt }) });
  const jev = createJevDecision({ endpoint: 'http://localhost/jev', fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ model: 'm', answers: Object.fromEntries(Object.keys(body.questions).map(key =>
      [key, { probabilities: { yes: 0.7, no: 0.3 } }])) }));
  } });
  expect(await jev.identity()).toEqual({ backend: 'jev-http', model: 'm', fingerprint: hash({ protocol: prompt,
    model: 'm', outcomes: [{ status: '2xx', decision: 'yes' }, { status: '2xx', decision: 'yes' }] }) });
});
