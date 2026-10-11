import { expect, it, vi } from 'vitest';
import type { InferenceProvider, InferenceRequest } from '../../contracts/index.js';
import type { CheckInstance } from '../decomposition/index.js';
import { stableDigest } from '../format/index.js';
import { runCouncil } from './council.js';
import { councilContentDigest, defaultGrokWindow } from './policy.js';
import { councilPromptVersion } from './protocol.js';
import type { CouncilOptions, CouncilOutput } from './types.js';

function setup(count = 100): CouncilOptions {
  const instances: CheckInstance[] = Array.from({ length: count }, (_, n) => ({
    id: `check-${n}`, template_id: 'support', unit_id: `unit-${n}`, type: 'choice',
    instructions: `Support ${n}?`, criteria: { yes: 'Supported', no: 'Unsupported' },
    options: ['yes', 'no'], expected: ['yes'], projection: { text: `Evidence ${n}` },
    digest: String(n), status: 'ready', reasons: [],
  }));
  const teachers = [{ id: 'c', provider: 'codex', model: 'c' }, { id: 'a', provider: 'claude', model: 'a' }];
  const providers = Object.fromEntries(teachers.map(teacher => [teacher.id, {
    id: teacher.id, capabilities: { billing: 'subscription', tools: 'disabled', seed: false, temperature: false },
    generate: vi.fn(async request => response(request)),
  } satisfies InferenceProvider]));
  return { outputDigest: 'output', instances, teachers, providers, now: new Date('2026-10-11T12:00:00Z') };
}
function response(request: InferenceRequest, answer = 'yes') {
  const { questions } = JSON.parse(request.prompt) as { questions: { key: string }[] };
  return { text: JSON.stringify(Object.fromEntries(questions.map(q => [q.key, { answer }]))),
    model: request.model, route: 'subscription', usage: null };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('sends 100 distinct projections in ordered 40/40/20 batches per teacher, each with its own evidence', async () => {
  const options = setup();
  const result = await runCouncil(options);
  expect(result.calls).toHaveLength(6);
  for (const provider of Object.values(options.providers)) {
    const requests = vi.mocked(provider.generate).mock.calls.map(([request]) => JSON.parse(request.prompt));
    expect(requests.map(request => request.questions.length)).toEqual([40, 40, 20]);
    const questions = requests.flatMap(request => request.questions);
    expect(requests.map(request => request.questions.map((q: { key: string }) => q.key)))
      .toEqual([40, 40, 20].map(count => Array.from({ length: count }, (_, index) => `q${index + 1}`)));
    expect(questions.map(q => q.evidence)).toEqual(options.instances.map(instance => instance.projection));
    expect(requests.every(request => Object.keys(request).join() === 'questions')).toBe(true);
    expect(questions.every(q => !Object.hasOwn(q, 'competing'))).toBe(true);
  }
  expect(Object.values(result.checks).every(check => check.final === 'yes')).toBe(true);
});

it('runs teachers concurrently with one call each in flight and a barrier before bounded adjudication', async () => {
  const options = setup(5); options.batchSize = 2;
  const slow = deferred(), started = deferred(), fastFinished = deferred();
  let active = 0, peak = 0, aCalls = 0, cCalls = 0;
  options.providers.a!.generate = vi.fn(async request => {
    aCalls++;
    if (aCalls === 1) { started.resolve(); await slow.promise; }
    return response(request, 'no');
  });
  options.providers.c!.generate = vi.fn(async request => {
    expect(active++).toBe(0); peak = Math.max(peak, active);
    const adjudication = request.system!.includes('Adversarially');
    if (adjudication) expect(aCalls).toBe(3);
    else if (++cCalls === 3) fastFinished.resolve();
    await Promise.resolve(); active--;
    return response(request, adjudication ? 'no' : 'yes');
  });
  const pending = runCouncil(options);
  await Promise.all([started.promise, fastFinished.promise]);
  expect(aCalls).toBe(1); expect(cCalls).toBe(3);
  expect(vi.mocked(options.providers.c!.generate).mock.calls.every(([r]) => !r.system!.includes('Adversarially'))).toBe(true);
  slow.resolve();
  const result = await pending;
  expect(peak).toBe(1);
  expect(result.calls.filter(call => call.phase === 'adjudication').map(call => call.check_ids.length)).toEqual([2, 2, 1, 2, 2, 1]);
  expect(Object.values(result.checks).every(check => check.final === 'no' && check.adjudication.length === 2)).toBe(true);
});

it('serializes immutable checkpoint snapshots and resumes received calls without regenerating them', async () => {
  const options = setup(100), blockedWrite = deferred(), firstWrite = deferred();
  let saved: CouncilOutput | undefined, writing = false, writes = 0;
  options.onCheckpoint = async output => {
    expect(writing).toBe(false); writing = true;
    const before = JSON.stringify(output);
    if (++writes === 1) { firstWrite.resolve(); await blockedWrite.promise; }
    expect(JSON.stringify(output)).toBe(before);
    const { digest, ...content } = output;
    expect(digest).toBe(councilContentDigest(content));
    saved = output; writing = false;
  };
  const controller = new AbortController();
  const pending = runCouncil({ ...options, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  await firstWrite.promise;
  expect(Object.values(options.providers).map(provider => vi.mocked(provider.generate).mock.calls.length)).toEqual([1, 1]);
  controller.abort(); blockedWrite.resolve(); await rejected;
  expect(saved!.calls).toHaveLength(2);
  expect(saved!.calls.every(call => call.outcome === 'received')).toBe(true);
  const original = structuredClone(saved!.calls);
  const result = await runCouncil({ ...options, previous: saved });
  expect(result.calls).toHaveLength(6);
  expect(result.complete).toBe(true);
  for (const provider of Object.values(options.providers)) expect(provider.generate).toHaveBeenCalledTimes(3);
  for (const call of original) expect(result.calls.find(item => item.id === call.id)).toMatchObject({
    at: call.at, wallMs: call.wallMs, usage: call.usage, outcome: 'completed',
  });
  await runCouncil({ ...options, previous: result });
  for (const provider of Object.values(options.providers)) expect(provider.generate).toHaveBeenCalledTimes(3);
});

it('drains in-flight teachers after a checkpoint failure and starts no more batches or adjudication', async () => {
  const options = setup(100), slow = deferred(), failedWrite = deferred();
  options.providers.a!.generate = vi.fn(async request => { await slow.promise; return response(request); });
  options.onCheckpoint = () => { failedWrite.resolve(); throw new Error('disk failure'); };
  let settled = false;
  const pending = runCouncil(options).finally(() => { settled = true; });
  const rejected = expect(pending).rejects.toThrow('disk failure');
  await failedWrite.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  slow.resolve(); await rejected;
  for (const provider of Object.values(options.providers)) expect(provider.generate).toHaveBeenCalledTimes(1);
});

it('pins batch size and the v5 protocol and refuses v4 checkpoint reuse', async () => {
  const options = setup(1), result = await runCouncil(options);
  expect(councilPromptVersion).toBe('paideia.council.v5');
  await expect(runCouncil({ ...options, previous: result, batchSize: 1 })).rejects.toThrow('Stale');
  const identity = stableDigest({ version: 'paideia.council.v4', output: options.outputDigest,
    instances: options.instances, teachers: options.teachers, batchSize: 40, adjudicator: 'c', window: defaultGrokWindow,
    windowOpen: false, active: ['c', 'a'], seed: 'paideia.council', timeoutMs: 120_000 });
  const { digest: _digest, ...old } = { ...result, identity };
  await expect(runCouncil({ ...options, previous: { ...old, digest: councilContentDigest(old) } })).rejects.toThrow('Stale');
});

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('refuses invalid batch size %s before inference', async batchSize => {
  const options = setup(1);
  await expect(runCouncil({ ...options, batchSize })).rejects.toThrow('batch size');
  for (const provider of Object.values(options.providers)) expect(provider.generate).not.toHaveBeenCalled();
});
